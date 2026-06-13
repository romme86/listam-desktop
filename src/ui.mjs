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
import { categoryIcon, tablerIcon } from './icons.mjs'
import { LOCALE_CHOICES, localeChoiceLabel } from './i18n.mjs'
import { nextTheme, THEME_CHOICES } from './prefs.mjs'
import { normalizeLeafBridgePort } from './leaf-bridge-config.mjs'

const NOTICE_TTL_MS = 4000
const NOTICE_LEAVE_MS = 180
const ROW_EXIT_MS = 160
const HINTS_LEAVE_MS = 150
const REMOTE_ATTRIBUTION_MS = 5000

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

export function mountApp({ root, store, client, locale, ownerControl = null, env = {} }) {
    const ui = {
        view: 'lists',
        dialog: null,
        editingItemId: null,
        focusedItemId: null,
        controlStatus: {},
        addBarOpen: false,
    }
    const now = env.now ?? (() => Date.now())

    // --- motion bookkeeping --------------------------------------------------
    // The renderer rebuilds the DOM on every store change, so animations are
    // driven by diffing against the previous render: only rows that appeared,
    // changed text, or flipped done-ness get a choreography class. Mutations
    // this client just sent are remembered briefly so backend echoes of our
    // own edits don't render as remote arrivals.
    const reduceMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false
    const recentLocal = { texts: new Map(), ids: new Map() }
    let prevItems = new Map()

    function pruneRecentLocal() {
        const cutoff = now() - REMOTE_ATTRIBUTION_MS
        for (const map of [recentLocal.texts, recentLocal.ids]) {
            for (const [key, at] of map) if (at < cutoff) map.delete(key)
        }
    }
    function markLocalText(text) {
        pruneRecentLocal()
        recentLocal.texts.set(text.trim().toLowerCase(), now())
    }
    function markLocalId(id) {
        pruneRecentLocal()
        recentLocal.ids.set(id, now())
    }
    function isRecentLocal(item) {
        const cutoff = now() - REMOTE_ATTRIBUTION_MS
        return (recentLocal.ids.get(item.id) ?? 0) >= cutoff
            || (recentLocal.texts.get(item.text.trim().toLowerCase()) ?? 0) >= cutoff
    }

    function rowAnimationClass(item) {
        // Bulk loads (initial sync, join) adopt silently — only deltas animate.
        if (prevItems.size === 0 && store.getState().items.length > 1) return ''
        const prev = prevItems.get(item.id)
        if (!prev) return isRecentLocal(item) ? ' row-enter' : ' row-remote'
        if (!prev.isDone && item.isDone) return ' row-flash'
        if (prev.isDone && !item.isDone) return ' row-unflash'
        if (prev.text !== item.text && !isRecentLocal(item)) return ' row-remote'
        return ''
    }

    // Local deletes animate out, then send; the backend echo removes the row.
    function animateRowExit(item, send, delayMs = 0) {
        const run = () => {
            const el = root.querySelector(`[data-item-id="${CSS.escape(item.id)}"]`)
            if (!el || reduceMotion()) return send()
            el.style.height = `${el.offsetHeight}px`
            void el.offsetHeight
            el.classList.add('row-exit')
            setTimeout(send, ROW_EXIT_MS)
        }
        if (delayMs > 0 && !reduceMotion()) setTimeout(run, delayMs)
        else run()
    }

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
            markLocalText(trimmed)
            send(RPC_ADD, { text: trimmed })
            return true
        },
        toggleItem(item) {
            markLocalId(item.id)
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
            markLocalId(item.id)
            send(RPC_UPDATE, { item: { ...item, text: trimmed, updatedAt: now() } })
        },
        deleteItem(item) {
            markLocalId(item.id)
            animateRowExit(item, () => send(RPC_DELETE, { item }))
        },
        clearDone() {
            selectDoneItems(store.getState().items).forEach((item, index) => {
                markLocalId(item.id)
                animateRowExit(item, () => send(RPC_DELETE, { item }), index * 40)
            })
        },
        cycleTheme() {
            store.setPreferences({ theme: nextTheme(store.getState().preferences.theme) })
        },
        summonAddBar() {
            ui.view = 'lists'
            ui.addBarOpen = true
            renderAll()
            queueMicrotask(() => root.querySelector('#add-item-input')?.focus())
        },
        dismissAddBar() {
            if (!ui.addBarOpen) return
            ui.addBarOpen = false
            renderAll()
        },
        toggleHints() {
            const bar = hintsHost.querySelector('.key-hints')
            if (store.getState().preferences.showKeyHints && bar && !reduceMotion()) {
                bar.classList.add('leaving')
                setTimeout(() => preferencesToggle('showKeyHints'), HINTS_LEAVE_MS)
            } else {
                preferencesToggle('showKeyHints')
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
        // Leaf-board bridge on/off. The preference records intent (auto-start
        // on next boot); the worker's status reply is the truth the UI shows.
        async setLeafBridge(enabled) {
            if (typeof client.bridge !== 'function') return
            store.setPreferences({ leafBridgeEnabled: enabled })
            const port = store.getState().preferences.leafBridgePort
            try {
                const status = await client.bridge(enabled ? 'start' : 'stop', { port })
                if (status) {
                    store.setState({ leafBridge: status })
                    if (enabled && !status.running) {
                        store.pushNotice(locale.i18n.t('desktop.leaf.startFailed'), 'error')
                    }
                }
            } catch {
                store.pushNotice(locale.i18n.t('desktop.leaf.startFailed'), 'error')
            }
        },
    }

    // --- skeleton ----------------------------------------------------------
    // Sidebar zones (design-guide proposal §5): brand, list rail (Overview and
    // the future typed lists render as disabled "soon" placeholders until the
    // project/list model lands), then status strip + system nav at the bottom.
    const RAIL_DEFS = [
        { key: 'overview', icon: 'layout-dashboard', soon: true, label: (t) => t('desktop.nav.overview') },
        { key: 'lists', icon: 'shopping-cart', label: (t) => t('desktop.rail.groceries') },
        { key: 'todo', icon: 'checklist', soon: true, label: (t) => t('desktop.rail.todo') },
        { key: 'travel', icon: 'plane', soon: true, label: (t) => t('desktop.rail.travel') },
    ]
    const SYSTEM_DEFS = [
        { key: 'peers', icon: 'users', label: (t) => t('desktop.nav.peers') },
        { key: 'diagnostics', icon: 'activity', label: (t) => t('desktop.nav.activity') },
        { key: 'settings', icon: 'settings', label: (t) => t('desktop.nav.settings'), action: () => openDialog({ kind: 'settings' }) },
    ]
    const navButtons = {}
    function navButton(def) {
        const btn = h('button', {
            class: `nav-item${def.soon ? ' soon' : ''}`,
            onclick: def.soon
                ? null
                : (def.action ?? (() => { ui.view = def.key; renderAll() })),
        })
        if (def.soon) btn.setAttribute('aria-disabled', 'true')
        navButtons[def.key] = btn
        return btn
    }
    const statusStrip = h('button', {
        class: 'status-strip',
        onclick: () => { ui.view = 'peers'; renderAll() },
    })
    const sidebar = h('aside', { class: 'sidebar' },
        h('div', { class: 'brand' },
            h('span', { class: 'brand-wordmark' }, 'Listam'),
        ),
        h('nav', { class: 'rail' }, ...RAIL_DEFS.map(navButton)),
        h('div', { class: 'sidebar-bottom' },
            statusStrip,
            h('nav', { class: 'system-nav' }, ...SYSTEM_DEFS.map(navButton)),
        ),
    )
    const main = h('main', { class: 'main' })
    const shell = h('div', { class: 'shell' }, sidebar, main)
    // Frameless Pear window chrome: drag strip + <pear-ctrl>, which asks the
    // runtime to show the macOS traffic lights anchored to it. In the browser
    // preview the element is undefined and the strip is inert.
    const titlebar = h('header', { class: 'titlebar', 'aria-hidden': 'true' },
        h('pear-ctrl', {}),
    )
    const hintsHost = h('div', {})
    const noticesHost = h('div', { class: 'notices' })
    const dialogHost = h('div', {})
    root.append(titlebar, shell, hintsHost, noticesHost, dialogHost)

    function openDialog(dialog) {
        ui.dialog = dialog
        renderAll()
    }
    function closeDialog() {
        ui.dialog = null
        renderAll()
    }

    // --- renderers ----------------------------------------------------------
    let prevPeerCount = null
    function renderNav(state) {
        const t = locale.i18n.t.bind(locale.i18n)
        const peersChanged = prevPeerCount !== null && prevPeerCount !== state.peerCount
        prevPeerCount = state.peerCount
        const remaining = selectSummary(state.items).remaining

        for (const def of [...RAIL_DEFS, ...SYSTEM_DEFS]) {
            const btn = navButtons[def.key]
            btn.replaceChildren(
                tablerIcon(def.icon, { size: 15 }),
                h('span', { class: 'nav-label' }, def.label(t)),
            )
            btn.classList.toggle('active', !def.soon && !def.action && ui.view === def.key)
            if (def.soon) {
                btn.append(h('span', { class: 'badge zero soon-chip' }, t('desktop.nav.soon')))
            } else if (def.key === 'lists') {
                btn.append(h('span', { class: `badge${remaining === 0 ? ' zero' : ''}` }, String(remaining)))
            } else if (def.key === 'peers') {
                btn.append(h('span', {
                    class: `badge${state.peerCount === 0 ? ' zero' : ''}${peersChanged ? ' pop' : ''}`,
                }, String(state.peerCount)))
            }
        }

        const live = state.peerCount > 0
        replaceChildren(statusStrip,
            h('span', { class: `dot${live ? ' live' : ''}` }),
            h('span', { class: 'label-sm' }, live
                ? `${t('desktop.status.live')} · ${t('desktop.status.peers', { count: state.peerCount })}`
                : t('desktop.status.local')),
        )
    }

    let prevPane = null
    function renderMain(state) {
        // Pane swaps (view change, list/grid flip) get an entrance; ordinary
        // state updates re-render in place without re-animating.
        const paneKey = `${ui.view}:${state.preferences.isGridView}`
        if (prevPane !== paneKey) {
            prevPane = paneKey
            main.classList.remove('pane-enter')
            void main.offsetWidth
            main.classList.add('pane-enter')
        }
        if (ui.view === 'peers') return renderPeersPane(state)
        if (ui.view === 'diagnostics') return renderDiagnosticsPane(state)
        return renderListsPane(state)
    }

    function renderHints(state) {
        const t = locale.i18n.t.bind(locale.i18n)
        const show = state.preferences.showKeyHints
        shell.classList.toggle('has-hints', show)
        if (!show) {
            hintsHost.replaceChildren()
            return
        }
        const hints = [
            ['N', t('desktop.hints.add')],
            ['G', t('desktop.hints.view')],
            ['Space', t('desktop.hints.done')],
            ['Del', t('desktop.hints.delete')],
            ['T', t('desktop.hints.theme')],
            ['?', t('desktop.hints.help')],
        ]
        replaceChildren(hintsHost,
            h('footer', { class: 'key-hints' },
                ...hints.map(([key, label]) => h('span', { class: 'hint' }, h('kbd', {}, key), label)),
                h('button', {
                    class: 'hints-close',
                    'aria-label': t('desktop.hints.hide'),
                    onclick: () => actions.toggleHints(),
                }, tablerIcon('x', { size: 13 })),
            ),
        )
    }

    function renderListsPane(state) {
        const t = locale.i18n.t.bind(locale.i18n)
        const { items, preferences } = state
        const summary = selectSummary(items)

        // The add-bar renders only when summoned (N or the + button). Escape
        // dismisses; blur dismisses when empty. Re-renders rebuild the input,
        // so typed text and focus carry across — mid-typing events (notices,
        // peer updates) never eat the draft.
        const previousAdd = main.querySelector('#add-item-input')
        const addInput = !ui.addBarOpen ? null : h('input', {
            class: 'input',
            id: 'add-item-input',
            placeholder: t('main.addItem.placeholder'),
            onkeydown: (event) => {
                if (event.key === 'Escape') {
                    event.stopPropagation()
                    actions.dismissAddBar()
                    return
                }
                if (event.key !== 'Enter') return
                const text = addInput.value
                addInput.value = ''
                if (!actions.addItem(text)) {
                    // The rejection notice re-rendered the pane; restore the
                    // draft on the live input and shake it alongside the notice.
                    const live = root.querySelector('#add-item-input') ?? addInput
                    live.value = text
                    if (text.trim()) {
                        live.classList.remove('shake')
                        void live.offsetWidth
                        live.classList.add('shake')
                    }
                }
            },
            onblur: () => {
                // Re-renders detach the focused input (blur) and then restore
                // focus on the rebuilt one; only dismiss when focus truly left.
                queueMicrotask(() => {
                    const live = root.querySelector('#add-item-input')
                    if (live && main.ownerDocument.activeElement === live) return
                    if (!live || !live.value.trim()) actions.dismissAddBar()
                })
            },
        })
        if (addInput && previousAdd) {
            addInput.value = previousAdd.value
            if (main.ownerDocument.activeElement === previousAdd) {
                queueMicrotask(() => addInput.focus())
            }
        }

        const statusKey = !state.backendReady
            ? 'header.status.starting'
            : state.peerCount > 0 ? 'header.status.synced' : 'header.status.ready'

        replaceChildren(main,
            h('header', { class: 'page-header' },
                h('h1', { class: 'page-title title-lg' }, t('desktop.rail.groceries')),
                h('div', { class: 'header-actions' },
                    h('button', {
                        class: 'btn btn-secondary btn-icon',
                        'aria-label': t('desktop.header.addItem'),
                        title: `${t('desktop.header.addItem')} (N)`,
                        onclick: actions.summonAddBar,
                    }, tablerIcon('plus', { size: 16 })),
                    h('button', {
                        class: 'btn btn-secondary btn-icon',
                        'aria-label': preferences.isGridView ? t('header.action.listView') : t('header.action.gridView'),
                        title: `${preferences.isGridView ? t('header.action.listView') : t('header.action.gridView')} (G)`,
                        onclick: () => { preferencesToggle('isGridView') },
                    }, tablerIcon(preferences.isGridView ? 'list' : 'layout-grid', { size: 16 })),
                    h('button', { class: 'btn btn-critical', onclick: actions.share }, t('desktop.header.share')),
                ),
            ),
            !ui.addBarOpen ? null : h('div', { class: 'add-bar' },
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
            class: `item-row body-md${item.isDone ? ' done' : ''}${rowAnimationClass(item)}`,
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
            h('span', { class: 'glyph' }, categoryIcon(section.canonicalKey, { size: 16 })),
            h('span', { class: 'item-text' }, item.text),
            h('button', {
                class: 'row-delete',
                'aria-label': t('main.item.delete'),
                onclick: (event) => {
                    event.stopPropagation()
                    actions.deleteItem(item)
                },
            }, tablerIcon('x', { size: 14 })),
        )
    }

    function renderGridCard(section, item) {
        return h('div', {
            class: `grid-card${item.isDone ? ' done' : ''}${rowAnimationClass(item)}`,
            tabindex: '0',
            role: 'button',
            'aria-pressed': item.isDone ? 'true' : 'false',
            dataset: { itemId: item.id },
            onclick: () => actions.toggleItem(item),
            onkeydown: (event) => handleItemKeys(event, item),
            onfocus: () => { ui.focusedItemId = item.id },
        },
            h('span', { class: 'glyph' }, categoryIcon(section.canonicalKey, { size: 24 })),
            h('span', { class: 'item-text label-md' }, item.text),
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
                h('h1', { class: 'page-title title-lg' }, t('desktop.peers.title')),
                h('div', { class: 'header-actions' },
                    h('button', { class: 'btn btn-secondary', onclick: () => openDialog({ kind: 'join' }) }, t('desktop.header.join')),
                    h('button', { class: 'btn btn-critical', onclick: actions.share }, t('desktop.header.share')),
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
            renderOwnedDevices(),
            renderLeafBridge(state),
        )
    }

    // Leaf-board bridge (hardware/leaf-peer, e.g. the ESP32-S3 leaf): a plain
    // TCP listener that always-on boards dial to mirror this project's cores.
    // The listener runs in the backend worker; this section toggles it and
    // surfaces the control-core key the board is provisioned with. The
    // browser preview's mock client has no bridge, so it shows the
    // unavailable state.
    function renderLeafBridge(state) {
        const t = locale.i18n.t.bind(locale.i18n)
        const section = (...children) => h('section', { class: 'pane-section' },
            h('h3', { class: 'category-heading label-sm' }, t('desktop.leaf.title')),
            ...children,
        )
        if (typeof client.bridge !== 'function') {
            return section(h('p', { class: 'body-md', style: 'color: var(--secondary); padding: 0 1rem;' }, t('desktop.leaf.unavailable')))
        }
        const leaf = state.leafBridge
        const running = Boolean(leaf?.running)
        const portInput = h('input', {
            class: 'input',
            type: 'number',
            min: '1',
            max: '65535',
            style: 'max-width: 120px;',
            value: String(state.preferences.leafBridgePort),
            disabled: running ? '' : null,
            'aria-label': t('desktop.leaf.port'),
            onchange: (event) => {
                const port = normalizeLeafBridgePort(event.target.value)
                if (port > 0) store.setPreferences({ leafBridgePort: port })
                else event.target.value = String(store.getState().preferences.leafBridgePort)
            },
        })
        return section(
            h('p', { class: 'body-md', style: 'color: var(--secondary); padding: 0 1rem;' }, t('desktop.leaf.description')),
            h('div', { class: 'summary-bar label-md' },
                h('span', { class: `dot${(leaf?.connections ?? 0) > 0 ? ' live' : ''}` }),
                h('span', {}, !running
                    ? t('desktop.leaf.off')
                    : (leaf.connections > 0
                        ? t('desktop.leaf.connected', { count: leaf.connections })
                        : t('desktop.leaf.waiting', { port: leaf.port }))),
            ),
            h('div', { class: 'choice-row', style: 'padding: 0 1rem;' },
                h('button', {
                    class: `btn ${running ? 'btn-primary' : 'btn-secondary'}`,
                    'aria-pressed': running ? 'true' : 'false',
                    onclick: () => actions.setLeafBridge(!running),
                }, running ? t('desktop.leaf.disable') : t('desktop.leaf.enable')),
                portInput,
            ),
            leaf?.error
                ? h('p', { class: 'body-md warning', style: 'padding: 0 1rem;' }, t('desktop.leaf.error', { message: leaf.error }))
                : null,
            running && leaf.controlKey
                ? h('div', {},
                    h('p', { class: 'body-md', style: 'color: var(--secondary); padding: 0 1rem;' }, t('desktop.leaf.keyHint')),
                    h('div', { class: 'invite-code' }, leaf.controlKey),
                    h('div', { style: 'margin-top: 1rem;' },
                        h('button', { class: 'btn btn-primary', onclick: () => copyLeafKey(leaf.controlKey) }, t('desktop.leaf.copy'))),
                )
                : null,
        )
    }

    // H1 owner-control: pair this desktop with a headless instance via an
    // operator-minted code, then query it with signed, capability-scoped
    // commands. Requires the Pear runtime (hyperdht); the browser preview
    // shows the section in its unavailable state.
    function renderOwnedDevices() {
        const t = locale.i18n.t.bind(locale.i18n)
        const section = (...children) => h('section', { class: 'pane-section' },
            h('h3', { class: 'category-heading label-sm' }, t('desktop.control.title')),
            ...children,
        )
        if (!ownerControl) {
            return section(h('p', { class: 'body-md', style: 'color: var(--secondary); padding: 0 1rem;' }, t('desktop.control.unavailable')))
        }

        const codeInput = h('input', { class: 'input', placeholder: t('desktop.control.codePlaceholder') })
        const nameInput = h('input', { class: 'input', placeholder: t('desktop.control.namePlaceholder'), style: 'max-width: 220px;' })
        const pairAction = async () => {
            try {
                const result = await ownerControl.pair(codeInput.value, nameInput.value)
                if (result?.ok) {
                    store.pushNotice(t('desktop.control.paired'), 'success')
                    renderAll()
                } else {
                    store.pushNotice(`${t('desktop.control.pairFailed')} (${result?.reason ?? 'error'})`, 'error')
                }
            } catch (error) {
                store.pushNotice(`${t('desktop.control.pairFailed')} (${error?.message ?? 'error'})`, 'error')
            }
        }

        const servers = ownerControl.listServers()
        return section(
            servers.length === 0
                ? h('p', { class: 'body-md', style: 'color: var(--secondary); padding: 0 1rem;' }, t('desktop.control.empty'))
                : h('div', { class: 'kv-rows' }, ...servers.map((server) => h('div', { class: 'member-row' },
                    h('span', {},
                        h('div', { class: 'body-md' }, server.name),
                        h('div', { class: 'label-sm', style: 'color: var(--outline);' }, `${t('desktop.control.capabilities')}: ${server.capabilities.join(', ') || '—'}`),
                        ui.controlStatus[server.serverPublicKeyHex]
                            ? h('div', { class: 'label-md', style: 'color: var(--secondary); margin-top: 0.25rem;' }, ui.controlStatus[server.serverPublicKeyHex])
                            : null,
                    ),
                    h('span', { class: 'role-chip' }, server.serverPublicKeyHex.slice(0, 8)),
                    h('button', {
                        class: 'btn btn-secondary',
                        onclick: async () => {
                            try {
                                const reply = await ownerControl.request(server.serverPublicKeyHex, 'status')
                                ui.controlStatus[server.serverPublicKeyHex] = reply?.ok
                                    ? JSON.stringify(reply.status)
                                    : `${t('desktop.control.queryFailed')} (${reply?.reason ?? 'error'})`
                            } catch (error) {
                                ui.controlStatus[server.serverPublicKeyHex] = `${t('desktop.control.queryFailed')} (${error?.message ?? 'error'})`
                            }
                            renderAll()
                        },
                    }, t('desktop.control.query')),
                ))),
            h('div', { class: 'add-bar', style: 'margin-top: 1.5rem; margin-bottom: 0;' },
                codeInput,
                nameInput,
                h('button', { class: 'btn btn-primary', onclick: pairAction }, t('desktop.control.pair')),
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
                h('h1', { class: 'page-title title-lg' }, t('desktop.diagnostics.title')),
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

    async function copyLeafKey(key) {
        try {
            await navigator.clipboard.writeText(key)
            store.pushNotice(locale.i18n.t('desktop.leaf.copied'), 'success')
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
        } else if (kind === 'settings') {
            const themeRow = h('div', { class: 'choice-row' },
                ...THEME_CHOICES.map((choice) => h('button', {
                    class: `btn ${state.preferences.theme === choice ? 'btn-primary' : 'btn-secondary'}`,
                    onclick: () => store.setPreferences({ theme: choice }),
                }, t(`desktop.theme.${choice}`))),
            )
            const hintsRow = h('div', { class: 'choice-row' },
                h('button', {
                    class: `btn ${state.preferences.showKeyHints ? 'btn-primary' : 'btn-secondary'}`,
                    'aria-pressed': state.preferences.showKeyHints ? 'true' : 'false',
                    onclick: () => actions.toggleHints(),
                },
                    state.preferences.showKeyHints ? t('desktop.settings.shown') : t('desktop.settings.hidden'),
                    h('kbd', {}, 'H'),
                ),
            )
            const languageRow = h('div', { class: 'choice-row' },
                ...LOCALE_CHOICES.map((choice) => h('button', {
                    class: `btn ${locale.choice === choice ? 'btn-primary' : 'btn-secondary'}`,
                    onclick: () => locale.setChoice(choice),
                }, localeChoiceLabel(locale.i18n, choice))),
            )
            content = dialogFrame(t('desktop.settings.title'), [
                h('h3', { class: 'category-heading label-sm' }, t('desktop.theme.label')),
                themeRow,
                h('h3', { class: 'category-heading label-sm' }, t('desktop.hints.show')),
                hintsRow,
                h('h3', { class: 'category-heading label-sm' }, t('header.section.language')),
                languageRow,
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
                ['T', t('desktop.shortcuts.cycleTheme')],
                ['H', t('desktop.shortcuts.toggleHints')],
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
            ...state.notices.map((notice) => h('div', {
                class: `notice ${notice.tone}`,
                dataset: { noticeId: String(notice.id) },
            }, notice.text)),
        )
        for (const notice of state.notices) {
            if (notice._timed) continue
            notice._timed = true
            setTimeout(() => {
                // Fade out in place, then drop from the store.
                noticesHost.querySelector(`[data-notice-id="${notice.id}"]`)?.classList.add('leaving')
                setTimeout(() => store.dismissNotice(notice.id), reduceMotion() ? 0 : NOTICE_LEAVE_MS)
            }, NOTICE_TTL_MS)
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
            actions.summonAddBar()
        } else if (event.key === 'g') {
            preferencesToggle('isGridView')
        } else if (event.key === 't') {
            actions.cycleTheme()
        } else if (event.key === 'h') {
            actions.toggleHints()
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
        renderHints(state)
        renderDialog(state)
        renderNotices(state)
        if (ui.focusedItemId && !ui.editingItemId) {
            root.querySelector(`[data-item-id="${CSS.escape(ui.focusedItemId)}"]`)?.focus?.()
        }
        // Snapshot for the next render's motion diff (rowAnimationClass).
        prevItems = new Map(state.items.map((item) => [item.id, { isDone: !!item.isDone, text: item.text }]))
    }

    store.subscribe(renderAll)
    renderAll()
    return { renderAll, openDialog, closeDialog, actions }
}
