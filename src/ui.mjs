// Desktop UI: a fixed sidebar plus three panes (lists, peers & devices,
// diagnostics), rendered with plain DOM against the kinetic-minimalist tokens
// in app.css. All user-facing copy resolves through the shared @listam/i18n
// catalogs; all backend interaction goes through the injected client's
// RPC command surface — the same numbers the mobile worklet uses.
import {
    RPC_ADD,
    RPC_UPDATE,
    RPC_DELETE,
    RPC_JOIN_KEY,
    RPC_CREATE_INVITE,
    RPC_REQUEST_SYNC,
    RPC_REMOVE_MEMBER,
    RPC_GET_MEMBERS,
    RPC_RECOVER_STORAGE,
} from '@listam/protocol'
import { groupByCategory, getDisplayCategoryName } from '@listam/grocery'
import { selectSummary, selectDoneItems } from './store.mjs'
import { categoryGlyph } from './icons.mjs'
import { LOCALE_CHOICES, localeChoiceLabel } from './i18n.mjs'

const NOTICE_TTL_MS = 4000

function replaceChildren(host, ...children) {
    host.replaceChildren(...children.filter((child) => child != null))
}

function h(tag, props = {}, ...children) {
    const el = document.createElement(tag)
    for (const [key, value] of Object.entries(props)) {
        if (key === 'class') el.className = value
        else if (key === 'dataset') Object.assign(el.dataset, value)
        else if (key.startsWith('on')) el.addEventListener(key.slice(2), value)
        else if (value !== undefined && value !== null) el.setAttribute(key, value)
    }
    for (const child of children.flat()) {
        if (child == null) continue
        el.append(child.nodeType ? child : document.createTextNode(String(child)))
    }
    return el
}

export function mountApp({ root, store, client, locale, env = {} }) {
    const ui = {
        view: 'lists',
        dialog: null,
        editingItemId: null,
        focusedItemId: null,
    }
    const now = env.now ?? (() => Date.now())

    // --- backend commands -------------------------------------------------
    const send = (command, payload) => Promise.resolve(client.send(command, payload)).catch(() => {
        store.pushNotice(locale.i18n.t('backend.startFailed'), 'error')
    })
    const actions = {
        addItem(text) {
            const trimmed = text.trim()
            if (!trimmed) return false
            const duplicate = store.getState().items.find(
                (item) => !item.isDone && item.text.trim().toLowerCase() === trimmed.toLowerCase(),
            )
            if (duplicate) {
                store.pushNotice(locale.i18n.t('main.notification.duplicateAdd', { text: trimmed }), 'info')
                return false
            }
            send(RPC_ADD, { text: trimmed })
            return true
        },
        toggleItem(item) {
            send(RPC_UPDATE, {
                item: {
                    ...item,
                    isDone: !item.isDone,
                    timeOfCompletion: item.isDone ? 0 : now(),
                    updatedAt: now(),
                },
            })
        },
        editItem(item, text) {
            const trimmed = text.trim()
            if (!trimmed || trimmed === item.text) return
            send(RPC_UPDATE, { item: { ...item, text: trimmed, updatedAt: now() } })
        },
        deleteItem(item) {
            send(RPC_DELETE, { item })
        },
        clearDone() {
            for (const item of selectDoneItems(store.getState().items)) {
                send(RPC_DELETE, { item })
            }
        },
        share() {
            send(RPC_CREATE_INVITE)
            openDialog({ kind: 'share' })
        },
        requestJoin(input) {
            const value = input.trim().replace(/\s+/g, '')
            if (!value) {
                store.pushNotice(locale.i18n.t('invite.notification.emptyManual'), 'error')
                return
            }
            // H2 parity: a join NEVER fires without an explicit confirmation
            // step that explains the base switch.
            openDialog({ kind: 'join-confirm', invite: value })
        },
        confirmJoin(invite) {
            store.setState({ isJoining: true })
            send(RPC_JOIN_KEY, { key: invite })
            closeDialog()
        },
        removeMember(member) {
            openDialog({ kind: 'member-remove', member })
        },
        confirmRemoveMember(member) {
            send(RPC_REMOVE_MEMBER, { writerKey: member.writerKey })
            closeDialog()
        },
        recover(action) {
            send(RPC_RECOVER_STORAGE, { action })
            closeDialog()
        },
        refresh() {
            send(RPC_REQUEST_SYNC)
            send(RPC_GET_MEMBERS)
        },
    }

    // --- skeleton ----------------------------------------------------------
    const navButtons = {}
    const sidebar = h('aside', { class: 'sidebar' },
        h('nav', {},
            ...['lists', 'peers', 'diagnostics'].map((view) => {
                const btn = h('button', {
                    class: 'nav-item',
                    onclick: () => { ui.view = view; renderAll() },
                })
                navButtons[view] = btn
                return btn
            }),
        ),
        h('div', { class: 'sidebar-footer' }),
    )
    const main = h('main', { class: 'main' })
    const noticesHost = h('div', { class: 'notices' })
    const dialogHost = h('div', {})
    root.append(h('div', { class: 'shell' }, sidebar, main), noticesHost, dialogHost)

    function openDialog(dialog) {
        ui.dialog = dialog
        renderAll()
    }
    function closeDialog() {
        ui.dialog = null
        renderAll()
    }

    // --- renderers ----------------------------------------------------------
    function renderNav(state) {
        const t = locale.i18n.t.bind(locale.i18n)
        const labels = { lists: t('desktop.nav.lists'), peers: t('desktop.nav.peers'), diagnostics: t('desktop.nav.diagnostics') }
        for (const [view, btn] of Object.entries(navButtons)) {
            btn.replaceChildren(labels[view])
            btn.classList.toggle('active', ui.view === view)
            if (view === 'peers') {
                btn.append(h('span', { class: `badge${state.peerCount === 0 ? ' zero' : ''}` }, String(state.peerCount)))
            }
        }

        const footer = sidebar.querySelector('.sidebar-footer')
        replaceChildren(footer,
            h('span', { class: 'label-sm' }, t('header.section.language')),
            h('div', {},
                ...LOCALE_CHOICES.map((choice) => h('button', {
                    class: `nav-item${locale.choice === choice ? ' active' : ''}`,
                    style: 'padding: 0.375rem 0.5rem;',
                    onclick: () => locale.setChoice(choice),
                }, localeChoiceLabel(locale.i18n, choice))),
            ),
        )
    }

    function renderMain(state) {
        if (ui.view === 'peers') return renderPeersPane(state)
        if (ui.view === 'diagnostics') return renderDiagnosticsPane(state)
        return renderListsPane(state)
    }

    function renderListsPane(state) {
        const t = locale.i18n.t.bind(locale.i18n)
        const { items, preferences } = state
        const summary = selectSummary(items)

        const addInput = h('input', {
            class: 'input',
            id: 'add-item-input',
            placeholder: t('main.addItem.placeholder'),
            onkeydown: (event) => {
                if (event.key !== 'Enter') return
                if (actions.addItem(addInput.value)) addInput.value = ''
            },
        })

        const statusKey = !state.backendReady
            ? 'header.status.starting'
            : state.peerCount > 0 ? 'header.status.synced' : 'header.status.ready'

        replaceChildren(main,
            h('header', { class: 'page-header' },
                h('h1', { class: 'page-title headline-sm' }, t('desktop.nav.lists')),
                h('div', { class: 'header-actions' },
                    h('button', { class: 'btn btn-secondary', onclick: () => { preferencesToggle('isGridView') } },
                        preferences.isGridView ? t('header.action.listView') : t('header.action.gridView')),
                    h('button', { class: 'btn btn-secondary', onclick: () => openDialog({ kind: 'members' }) }, t('header.action.membersRecovery')),
                    h('button', { class: 'btn btn-secondary', onclick: () => openDialog({ kind: 'join' }) }, t('desktop.header.join')),
                    h('button', { class: 'btn btn-secondary', onclick: actions.share }, t('desktop.header.share')),
                ),
            ),
            h('div', { class: 'add-bar' },
                addInput,
                h('span', { class: 'add-hint label-md' }, t('desktop.addItem.hint')),
            ),
            h('div', { class: 'summary-bar label-md' },
                h('span', { class: `dot${state.peerCount > 0 ? ' live' : ''}` }),
                h('span', {}, t(statusKey, { count: state.peerCount })),
                h('span', {}, summary.remaining === 0 && summary.total > 0
                    ? t('main.summary.allDone')
                    : t('main.summary.itemsLeft', { count: summary.remaining })),
                summary.done > 0
                    ? h('button', { class: 'btn btn-secondary', onclick: actions.clearDone }, t('main.summary.clearDone'))
                    : null,
            ),
            state.isJoining ? renderJoinOverlay(state) : null,
            items.length === 0 ? renderEmptyState() : renderItems(state),
        )
    }

    function renderJoinOverlay(state) {
        const t = locale.i18n.t.bind(locale.i18n)
        const phase = state.joinPhase || 'default'
        return h('div', { class: 'join-overlay pane-section' },
            h('h2', { class: 'headline-sm' }, t(`joining.phase.${phase}.title`)),
            h('p', { class: 'phase body-md' }, t(`joining.phase.${phase}.subtitle`)),
        )
    }

    function renderEmptyState() {
        const t = locale.i18n.t.bind(locale.i18n)
        return h('div', { class: 'empty-state' },
            h('h2', {}, t('main.empty.title')),
            h('p', {}, t('main.empty.subtitle')),
            h('p', { class: 'label-md' }, t('main.empty.hintToggle')),
            h('p', { class: 'label-md' }, t('main.empty.hintEdit')),
            h('p', { class: 'label-md' }, t('main.empty.hintDelete')),
        )
    }

    function renderItems(state) {
        const { items, preferences } = state
        const sections = preferences.categoriesEnabled
            ? groupByCategory(items, locale.i18n.groceryLocale)
            : [{ canonicalKey: 'Others', category: '', items: items.map((entry, originalIndex) => ({ entry, originalIndex })) }]

        return h('div', {},
            ...sections.map((section) => h('section', { class: 'category-section' },
                preferences.categoriesEnabled && preferences.categoryHeaders
                    ? h('h3', { class: 'category-heading label-sm' },
                        getDisplayCategoryName(section.canonicalKey, locale.i18n.groceryLocale))
                    : null,
                preferences.isGridView
                    ? h('div', { class: 'grid-cards' }, ...section.items.map(({ entry }) => renderGridCard(section, entry)))
                    : h('div', { class: 'item-rows' }, ...section.items.map(({ entry }) => renderItemRow(section, entry))),
            )),
        )
    }

    function renderItemRow(section, item) {
        const t = locale.i18n.t.bind(locale.i18n)
        if (ui.editingItemId === item.id) {
            const editInput = h('input', {
                class: 'input',
                value: item.text,
                placeholder: t('main.item.editPlaceholder'),
                onkeydown: (event) => {
                    if (event.key === 'Enter') {
                        actions.editItem(item, editInput.value)
                        ui.editingItemId = null
                        renderAll()
                    } else if (event.key === 'Escape') {
                        ui.editingItemId = null
                        renderAll()
                    }
                },
                onblur: () => {
                    ui.editingItemId = null
                    renderAll()
                },
            })
            const row = h('div', { class: 'item-row', dataset: { itemId: item.id } }, editInput)
            queueMicrotask(() => editInput.focus())
            return row
        }

        return h('div', {
            class: `item-row body-md${item.isDone ? ' done' : ''}`,
            tabindex: '0',
            role: 'button',
            'aria-pressed': item.isDone ? 'true' : 'false',
            dataset: { itemId: item.id },
            onclick: () => actions.toggleItem(item),
            ondblclick: (event) => {
                event.preventDefault()
                ui.editingItemId = item.id
                renderAll()
            },
            onkeydown: (event) => handleItemKeys(event, item),
            onfocus: () => { ui.focusedItemId = item.id },
        },
            h('span', { class: 'glyph' }, categoryGlyph(section.canonicalKey)),
            h('span', {}, item.text),
            h('button', {
                class: 'row-delete label-md',
                'aria-label': t('main.item.delete'),
                onclick: (event) => {
                    event.stopPropagation()
                    actions.deleteItem(item)
                },
            }, '✕'),
        )
    }

    function renderGridCard(section, item) {
        return h('div', {
            class: `grid-card${item.isDone ? ' done' : ''}`,
            tabindex: '0',
            role: 'button',
            'aria-pressed': item.isDone ? 'true' : 'false',
            dataset: { itemId: item.id },
            onclick: () => actions.toggleItem(item),
            onkeydown: (event) => handleItemKeys(event, item),
            onfocus: () => { ui.focusedItemId = item.id },
        },
            h('span', { class: 'glyph' }, categoryGlyph(section.canonicalKey)),
            h('span', { class: 'label-md' }, item.text),
        )
    }

    function handleItemKeys(event, item) {
        if (event.key === ' ' || event.key === 'Enter' || event.key === 'x') {
            event.preventDefault()
            actions.toggleItem(item)
        } else if (event.key === 'Delete' || event.key === 'Backspace' || event.key === 'd') {
            event.preventDefault()
            actions.deleteItem(item)
        }
    }

    function renderPeersPane(state) {
        const t = locale.i18n.t.bind(locale.i18n)
        const members = state.roster?.writers ?? []
        replaceChildren(main,
            h('header', { class: 'page-header' },
                h('h1', { class: 'page-title headline-sm' }, t('desktop.peers.title')),
                h('div', { class: 'header-actions' },
                    h('button', { class: 'btn btn-secondary', onclick: actions.share }, t('desktop.header.share')),
                ),
            ),
            h('section', { class: 'pane-section' },
                h('div', { class: 'summary-bar label-md' },
                    h('span', { class: `dot${state.peerCount > 0 ? ' live' : ''}` }),
                    h('span', {}, state.peerCount === 0
                        ? t('desktop.peers.none')
                        : t('desktop.peers.connected', { count: state.peerCount })),
                ),
            ),
            h('section', { class: 'pane-section' },
                h('h3', { class: 'category-heading label-sm' }, t('desktop.peers.invite.title')),
                state.inviteKey
                    ? h('div', {},
                        h('div', { class: 'invite-code' }, state.inviteKey),
                        h('div', { style: 'margin-top: 1rem;' },
                            h('button', { class: 'btn btn-primary', onclick: copyInvite }, t('desktop.peers.copy'))),
                    )
                    : h('p', { class: 'body-md', style: 'color: var(--secondary); padding: 0 1rem;' }, t('desktop.peers.invite.none')),
            ),
            h('section', { class: 'pane-section' },
                h('h3', { class: 'category-heading label-sm' }, t('members.title')),
                h('div', { class: 'kv-rows' }, ...renderMemberRows(members)),
            ),
        )
    }

    function renderMemberRows(members) {
        const t = locale.i18n.t.bind(locale.i18n)
        if (members.length === 0) {
            return [h('p', { class: 'body-md', style: 'color: var(--secondary); padding: 0 1rem;' }, t('members.subtitle.none'))]
        }
        const canAdminister = store.getState().roster?.canAdminister
        return members.map((member) => h('div', { class: 'member-row' },
            h('span', { class: 'who' }, member.writerKey),
            h('span', { class: `role-chip${member.isOwner ? ' owner' : ''}` },
                member.isOwner ? t('members.role.owner') : member.isSelf ? t('members.role.self') : t('members.role.member')),
            canAdminister && !member.isSelf && !member.isOwner
                ? h('button', { class: 'btn btn-danger', onclick: () => actions.removeMember(member) }, t('common.remove'))
                : h('span', {}),
        ))
    }

    function renderDiagnosticsPane(state) {
        const t = locale.i18n.t.bind(locale.i18n)
        replaceChildren(main,
            h('header', { class: 'page-header' },
                h('h1', { class: 'page-title headline-sm' }, t('desktop.diagnostics.title')),
            ),
            h('section', { class: 'pane-section' },
                h('h3', { class: 'category-heading label-sm' }, t('desktop.diagnostics.summary')),
                h('div', { class: 'kv-rows' },
                    kvRow(t('desktop.diagnostics.backendReady'), state.backendReady ? t('header.status.ready') : t('header.status.starting')),
                    kvRow(t('desktop.diagnostics.peerCount'), String(state.peerCount)),
                    kvRow(t('desktop.diagnostics.joinPhase'), state.joinPhase ?? '—'),
                    kvRow(t('desktop.diagnostics.locale'), `${locale.i18n.locale} / ${locale.i18n.groceryLocale}`),
                ),
            ),
            h('section', { class: 'pane-section' },
                h('h3', { class: 'category-heading label-sm' }, t('desktop.diagnostics.events')),
                state.diagnostics.length === 0
                    ? h('p', { class: 'body-md', style: 'color: var(--secondary); padding: 0 1rem;' }, t('desktop.diagnostics.empty'))
                    : h('div', { class: 'event-log' },
                        ...state.diagnostics.slice().reverse().map((entry) => h('div', { class: 'event-line' },
                            h('span', { class: 'ts' }, formatTime(entry.at)),
                            h('span', {}, entry.label),
                        ))),
            ),
        )
    }

    function kvRow(key, value) {
        return h('div', { class: 'kv-row' },
            h('span', { class: 'k label-md' }, key),
            h('span', { class: 'v body-md' }, value),
        )
    }

    function formatTime(at) {
        try {
            return locale.i18n.date(new Date(at), { hour: '2-digit', minute: '2-digit', second: '2-digit' })
        } catch {
            return ''
        }
    }

    async function copyInvite() {
        const key = store.getState().inviteKey
        if (!key) return
        try {
            await navigator.clipboard.writeText(key)
            store.pushNotice(locale.i18n.t('desktop.peers.copied'), 'success')
        } catch {
            store.pushNotice(locale.i18n.t('invite.share.failed'), 'error')
        }
    }

    // --- dialogs -------------------------------------------------------------
    function renderDialog(state) {
        if (!ui.dialog && state.recovery) {
            // Phase 11 parity: surface the storage-recovery decision as soon as
            // the backend reports it.
            ui.dialog = { kind: 'recovery' }
        }
        if (!ui.dialog) {
            dialogHost.replaceChildren()
            return
        }
        const t = locale.i18n.t.bind(locale.i18n)
        const { kind } = ui.dialog
        let content = null

        if (kind === 'share') {
            content = dialogFrame(t('invite.share.title'), [
                h('p', { class: 'dialog-body' }, t('invite.share.message')),
                state.inviteKey
                    ? h('div', { class: 'invite-code' }, state.inviteKey)
                    : h('p', { class: 'dialog-body' }, t('invite.share.notReady')),
            ], [
                state.inviteKey ? h('button', { class: 'btn btn-secondary', onclick: copyInvite }, t('desktop.peers.copy')) : null,
                h('button', { class: 'btn btn-primary', onclick: closeDialog }, t('common.close')),
            ])
        } else if (kind === 'join') {
            const joinInput = h('input', {
                class: 'input',
                placeholder: t('invite.dialog.placeholder'),
                onkeydown: (event) => {
                    if (event.key === 'Enter') actions.requestJoin(joinInput.value)
                },
            })
            content = dialogFrame(t('invite.dialog.title'), [
                h('p', { class: 'dialog-body' }, t('invite.dialog.subtitle')),
                joinInput,
            ], [
                h('button', { class: 'btn btn-secondary', onclick: closeDialog }, t('common.cancel')),
                h('button', { class: 'btn btn-primary', onclick: () => actions.requestJoin(joinInput.value) }, t('common.join')),
            ])
            queueMicrotask(() => joinInput.focus())
        } else if (kind === 'join-confirm') {
            // Desktop joins are always manual paste (no deep links), so the
            // confirmation uses the manual source text and no link warning.
            content = dialogFrame(t('invite.confirm.title'), [
                h('p', { class: 'dialog-body', style: 'white-space: pre-line;' }, t('invite.confirm.message', {
                    sourceText: t('invite.confirm.sourceManual'),
                    trustWarning: '',
                })),
            ], [
                h('button', { class: 'btn btn-secondary', onclick: closeDialog }, t('common.cancel')),
                h('button', { class: 'btn btn-primary', onclick: () => actions.confirmJoin(ui.dialog.invite) }, t('common.join')),
            ])
        } else if (kind === 'members') {
            content = dialogFrame(t('members.title'), [
                h('p', { class: 'dialog-body' },
                    (state.roster?.writers?.length ?? 0) > 1 ? t('members.subtitle.shared') : t('members.subtitle.none')),
                h('div', { class: 'kv-rows' }, ...renderMemberRows(state.roster?.writers ?? [])),
            ], [
                h('button', { class: 'btn btn-primary', onclick: closeDialog }, t('common.close')),
            ])
        } else if (kind === 'member-remove') {
            content = dialogFrame(t('members.confirmRemove.title'), [
                h('p', { class: 'dialog-body' }, t('members.confirmRemove.message')),
            ], [
                h('button', { class: 'btn btn-secondary', onclick: closeDialog }, t('common.cancel')),
                h('button', { class: 'btn btn-danger', onclick: () => actions.confirmRemoveMember(ui.dialog.member) }, t('common.remove')),
            ])
        } else if (kind === 'recovery') {
            content = dialogFrame(t('backend.recovery.title'), [
                h('p', { class: 'dialog-body' }, t('backend.recovery.message')),
            ], [
                h('button', { class: 'btn btn-secondary', onclick: closeDialog }, t('common.cancel')),
                h('button', { class: 'btn btn-danger', onclick: () => openDialog({ kind: 'recovery-confirm' }) }, t('backend.recovery.reset')),
                h('button', { class: 'btn btn-primary', onclick: () => actions.recover('retry') }, t('backend.recovery.retry')),
            ])
        } else if (kind === 'recovery-confirm') {
            content = dialogFrame(t('backend.recovery.confirmTitle'), [
                h('p', { class: 'dialog-body warning' }, t('backend.recovery.confirmMessage')),
            ], [
                h('button', { class: 'btn btn-secondary', onclick: closeDialog }, t('common.cancel')),
                h('button', { class: 'btn btn-danger', onclick: () => actions.recover('reset') }, t('backend.recovery.confirmReset')),
            ])
        } else if (kind === 'shortcuts') {
            const rows = [
                ['N', t('desktop.shortcuts.addItem')],
                ['G', t('desktop.shortcuts.toggleView')],
                ['↑ ↓', t('desktop.shortcuts.navigate')],
                ['Space', t('desktop.shortcuts.toggleDone')],
                ['Delete', t('desktop.shortcuts.deleteItem')],
                ['?', t('desktop.shortcuts.help')],
                ['Esc', t('desktop.shortcuts.close')],
            ]
            content = dialogFrame(t('desktop.shortcuts.title'), [
                h('div', { class: 'shortcut-rows' }, ...rows.map(([key, label]) => h('div', { class: 'kv-row' },
                    h('span', {}, h('kbd', {}, key)),
                    h('span', { class: 'body-md' }, label),
                ))),
            ], [
                h('button', { class: 'btn btn-primary', onclick: closeDialog }, t('common.close')),
            ])
        }

        replaceChildren(dialogHost,
            h('div', { class: 'dialog-backdrop', onclick: (event) => { if (event.target === event.currentTarget) closeDialog() } }, content),
        )
    }

    function dialogFrame(title, body, dialogActions) {
        return h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true' },
            h('h2', { class: 'headline-sm' }, title),
            h('div', { class: 'dialog-body body-md' }, ...body),
            h('div', { class: 'dialog-actions' }, ...dialogActions.filter(Boolean)),
        )
    }

    function renderNotices(state) {
        replaceChildren(noticesHost,
            ...state.notices.map((notice) => h('div', { class: `notice ${notice.tone}` }, notice.text)),
        )
        for (const notice of state.notices) {
            if (notice._timed) continue
            notice._timed = true
            setTimeout(() => store.dismissNotice(notice.id), NOTICE_TTL_MS)
        }
    }

    function preferencesToggle(key) {
        store.setPreferences({ [key]: !store.getState().preferences[key] })
    }

    // --- keyboard-first actions ----------------------------------------------
    function isTypingTarget(target) {
        return target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')
    }

    root.ownerDocument.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            if (ui.dialog) closeDialog()
            return
        }
        if (isTypingTarget(event.target) || ui.dialog) return

        if (event.key === 'n' || event.key === '/') {
            event.preventDefault()
            root.querySelector('#add-item-input')?.focus()
        } else if (event.key === 'g') {
            preferencesToggle('isGridView')
        } else if (event.key === '?') {
            openDialog({ kind: 'shortcuts' })
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            const rows = [...root.querySelectorAll('[data-item-id]')]
            if (rows.length === 0) return
            const index = rows.findIndex((row) => row.dataset.itemId === ui.focusedItemId)
            const next = event.key === 'ArrowDown'
                ? rows[Math.min(rows.length - 1, index + 1)]
                : rows[Math.max(0, index <= 0 ? 0 : index - 1)]
            next?.focus()
        }
    })

    // --- render loop ----------------------------------------------------------
    function renderAll() {
        const state = store.getState()
        renderNav(state)
        renderMain(state)
        renderDialog(state)
        renderNotices(state)
        if (ui.focusedItemId && !ui.editingItemId) {
            root.querySelector(`[data-item-id="${CSS.escape(ui.focusedItemId)}"]`)?.focus?.()
        }
    }

    store.subscribe(renderAll)
    renderAll()
    return { renderAll, openDialog, closeDialog, actions }
}
