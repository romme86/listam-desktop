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
    RPC_GET_BOARD_CONFIG,
    RPC_SET_BOARD_CONFIG,
} from '@listam/protocol'
import { groupByCategory, getDisplayCategoryName } from '@listam/grocery'
import { isTodoType, TODO_LIST_TYPE } from '@listam/domain/identity'
import { selectSummary, selectDoneItems } from './store.mjs'
import { categoryIcon, tablerIcon } from './icons.mjs'
import { LOCALE_CHOICES, localeChoiceLabel } from './i18n.mjs'
import { nextTheme, THEME_CHOICES } from './prefs.mjs'
import { normalizeLeafBridgePort } from './leaf-bridge-config.mjs'
import {
    isBoardType,
    BOARD_WRITE_TYPE,
    selectBoardConfig,
    groupByStatus,
    ticketBadges,
    selectWriterStats,
    validateRigorDraft,
    buildStatusChange,
    formatDuration,
    deltaPercent,
    BLOCK_TYPES,
    createBlock,
    blockToText,
    blockFromText,
    normalizeBlocks,
    renderInlineMarkdown,
    renderMarkdownBlock,
} from './ticket.mjs'

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

// Grocery surfaces (the lists pane, its count, clear-done) operate on ordinary
// grocery list items only. Board tickets live on their own board, and to-do
// items are plain text with no grocery intelligence — both are excluded so they
// are never shown, counted, categorized, or cleared alongside groceries. The
// desktop has no dedicated to-do surface yet (the rail's "todo" entry is still
// "soon"), so to-do lists synced from mobile are simply not surfaced here rather
// than corrupting the grocery view with category grouping.
function isGroceryItem(item) {
    return !!item && !isBoardType(item.listType) && !isTodoType(item.listType)
}

// The to-do surface: plain text items (isTodoType), the mirror of isGroceryItem
// for the grocery surface and isBoardType for the board.
function isTodoItem(item) {
    return !!item && isTodoType(item.listType)
}

export function mountApp({ root, store, client, locale, ownerControl = null, env = {} }) {
    const ui = {
        view: 'lists',
        dialog: null,
        editingItemId: null,
        focusedItemId: null,
        controlStatus: {},
        addBarOpen: false,
        // Board detail: selectedTicketId drives the right-hand split panel
        // (board stays on the left); ticketDocId promotes the same ticket to
        // the full-screen document view. blockEditingId/blockDraft/blockMenu/
        // blockDrag are UI-local block-editor state kept off the store so block
        // edits never round-trip through a store update mid-keystroke.
        selectedTicketId: null,
        ticketDocId: null,
        blockEditingId: null,
        blockDraft: '',
        blockMenu: null,
        blockDrag: null,
        boardDrag: null,
        boardConfigRequested: false,
    }
    const now = env.now ?? (() => Date.now())
    // Block ids only need to be unique within a session; the renderer rebuilds
    // the DOM wholesale, so a monotonic counter mixed with the clock suffices.
    let blockIdSeq = 0
    const nextBlockId = () => `b-${now()}-${blockIdSeq++}`

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
            // The add bar serves whichever simple-list surface is showing. A
            // to-do add carries listType so the backend files it on the to-do
            // list; dedupe is scoped to that same surface.
            const isTodo = ui.view === 'todo'
            const onSurface = isTodo ? isTodoItem : isGroceryItem
            const duplicate = store.getState().items.find(
                (item) => onSurface(item) && !item.isDone && item.text.trim().toLowerCase() === trimmed.toLowerCase(),
            )
            if (duplicate) {
                store.pushNotice(locale.i18n.t('main.notification.duplicateAdd', { text: trimmed }), 'info')
                return false
            }
            markLocalText(trimmed)
            send(RPC_ADD, isTodo ? { text: trimmed, listType: TODO_LIST_TYPE } : { text: trimmed })
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
            const onSurface = ui.view === 'todo' ? isTodoItem : isGroceryItem
            selectDoneItems(store.getState().items.filter(onSurface)).forEach((item, index) => {
                markLocalId(item.id)
                animateRowExit(item, () => send(RPC_DELETE, { item }), index * 40)
            })
        },
        // --- board --------------------------------------------------------
        newTicket() {
            openDialog({ kind: 'add-ticket', draft: { description: '', tasks: [''], hours: '', complexity: 50 } })
        },
        // The backend freezes time-in-progress + the on-time verdict from this
        // status change; the frontend only sends the new status with a bumped
        // updatedAt (so the LWW reducer never drops it).
        moveTicket(item, status) {
            const payload = buildStatusChange(item, status, now())
            if (!payload) return
            markLocalId(item.id)
            send(RPC_UPDATE, { item: payload })
        },
        toggleTicketTask(item, taskId) {
            const checklist = (Array.isArray(item.checklist) ? item.checklist : [])
                .map((task) => (task.id === taskId ? { ...task, done: !task.done } : task))
            markLocalId(item.id)
            send(RPC_UPDATE, { item: { ...item, checklist, updatedAt: now() } })
        },
        // Card click -> right-hand split panel (board stays on the left).
        openTicket(id) {
            ui.selectedTicketId = id
            ui.ticketDocId = null
            ui.blockEditingId = null
            ui.blockMenu = null
            ui.view = 'board'
            renderAll()
        },
        promoteTicket(id) {
            ui.selectedTicketId = id
            ui.ticketDocId = id
            ui.blockMenu = null
            renderAll()
        },
        collapseTicket() {
            ui.ticketDocId = null
            ui.blockMenu = null
            renderAll()
        },
        closeTicket() {
            ui.selectedTicketId = null
            ui.ticketDocId = null
            ui.blockEditingId = null
            ui.blockDraft = ''
            ui.blockMenu = null
            renderAll()
        },
        // Generic single-field ticket edit. Always bumps updatedAt so the LWW
        // reducer never drops it; the backend recomputes time/timeliness when
        // the status changes (status moves go through moveTicket instead).
        updateTicket(item, patch) {
            markLocalId(item.id)
            send(RPC_UPDATE, { item: { ...item, ...patch, updatedAt: now() } })
        },
        // --- block-based body --------------------------------------------
        commitBlocks(item, blocks) {
            const current = normalizeBlocks(item.blocks)
            if (JSON.stringify(current) === JSON.stringify(blocks)) {
                renderAll()
                return
            }
            markLocalId(item.id)
            send(RPC_UPDATE, { item: { ...item, blocks, updatedAt: now() } })
        },
        startBlockEdit(item, block) {
            // Switching blocks: flush the block being edited first so its draft
            // is never lost.
            if (ui.blockEditingId && ui.blockEditingId !== block.id) {
                actions.commitBlocks(item, blocksWithPendingEdit(item))
            }
            ui.blockEditingId = block.id
            ui.blockDraft = blockToText(block)
            ui.blockMenu = null
            renderAll()
        },
        commitBlockEdit(item) {
            if (!ui.blockEditingId) return
            const blocks = blocksWithPendingEdit(item)
            ui.blockEditingId = null
            ui.blockDraft = ''
            ui.blockMenu = null
            actions.commitBlocks(item, blocks)
            renderAll()
        },
        cancelBlockEdit() {
            ui.blockEditingId = null
            ui.blockDraft = ''
            ui.blockMenu = null
            renderAll()
        },
        insertBlock(item, type, afterId = null) {
            const block = createBlock(type, nextBlockId())
            const blocks = normalizeBlocks(item.blocks)
            let next
            if (afterId == null) {
                next = [...blocks, block]
            } else {
                const idx = blocks.findIndex((b) => b.id === afterId)
                next = idx < 0 ? [...blocks, block] : [...blocks.slice(0, idx + 1), block, ...blocks.slice(idx + 1)]
            }
            ui.blockMenu = null
            ui.blockEditingId = block.id
            ui.blockDraft = blockToText(block)
            actions.commitBlocks(item, next)
            renderAll()
        },
        replaceBlock(item, blockId, type) {
            const block = createBlock(type, blockId)
            const blocks = normalizeBlocks(item.blocks).map((b) => (b.id === blockId ? block : b))
            ui.blockMenu = null
            ui.blockEditingId = blockId
            ui.blockDraft = blockToText(block)
            actions.commitBlocks(item, blocks)
            renderAll()
        },
        deleteBlock(item, blockId) {
            const blocks = normalizeBlocks(item.blocks).filter((b) => b.id !== blockId)
            if (ui.blockEditingId === blockId) {
                ui.blockEditingId = null
                ui.blockDraft = ''
            }
            ui.blockMenu = null
            actions.commitBlocks(item, blocks)
            renderAll()
        },
        moveBlock(item, dragId, targetId) {
            if (dragId === targetId) return
            const blocks = normalizeBlocks(item.blocks)
            const moved = blocks.find((b) => b.id === dragId)
            if (!moved) return
            const rest = blocks.filter((b) => b.id !== dragId)
            const ti = rest.findIndex((b) => b.id === targetId)
            if (ti < 0) rest.push(moved)
            else rest.splice(ti, 0, moved)
            actions.commitBlocks(item, rest)
        },
        toggleChecklistBlockItem(item, blockId, index) {
            const blocks = normalizeBlocks(item.blocks).map((b) => {
                if (b.id !== blockId) return b
                const items = (Array.isArray(b.items) ? b.items : []).map((it, i) => (i === index ? { ...it, done: !it.done } : it))
                return { ...b, items }
            })
            actions.commitBlocks(item, blocks)
        },
        openBlockMenu(spec) {
            ui.blockMenu = spec
            renderAll()
        },
        closeBlockMenu() {
            ui.blockMenu = null
            renderAll()
        },
        setRigor(on) {
            send(RPC_SET_BOARD_CONFIG, { config: { rigorOn: !!on } })
        },
        cycleTheme() {
            store.setPreferences({ theme: nextTheme(store.getState().preferences.theme) })
        },
        summonAddBar() {
            // Stay on whichever simple-list surface is showing (grocery or
            // to-do); from any other view default to the grocery list.
            if (ui.view !== 'lists' && ui.view !== 'todo') ui.view = 'lists'
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
        { key: 'board', icon: 'layout-grid', label: (t) => t('desktop.rail.board') },
        { key: 'todo', icon: 'checklist', label: (t) => t('desktop.rail.todo') },
        { key: 'travel', icon: 'plane', soon: true, label: (t) => t('desktop.rail.travel') },
    ]
    const SYSTEM_DEFS = [
        { key: 'peers', icon: 'users', label: (t) => t('desktop.nav.peers') },
        { key: 'congruency', icon: 'activity', label: (t) => t('desktop.nav.congruency') },
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
        const remaining = selectSummary(state.items.filter(isGroceryItem)).remaining

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
            } else if (def.key === 'board') {
                const inProgress = state.items.filter((i) => isBoardType(i.listType) && i.status === 'in_progress').length
                btn.append(h('span', { class: `badge${inProgress === 0 ? ' zero' : ''}` }, String(inProgress)))
            } else if (def.key === 'todo') {
                const todoLeft = selectSummary(state.items.filter(isTodoItem)).remaining
                btn.append(h('span', { class: `badge${todoLeft === 0 ? ' zero' : ''}` }, String(todoLeft)))
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
        // Pane swaps (view change, list/grid flip, entering the full-screen
        // ticket doc) get an entrance; ordinary state updates re-render in place
        // without re-animating.
        const paneKey = `${ui.ticketDocId ? `doc:${ui.ticketDocId}` : ui.view}:${state.preferences.isGridView}`
        if (prevPane !== paneKey) {
            prevPane = paneKey
            main.classList.remove('pane-enter')
            void main.offsetWidth
            main.classList.add('pane-enter')
        }
        if (ui.ticketDocId) return renderTicketFull(state)
        if (ui.view === 'board') return renderBoardPane(state)
        if (ui.view === 'todo') return renderTodoPane(state)
        if (ui.view === 'congruency') return renderCongruencyPane(state)
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

    // The add-bar is shared by the grocery and to-do surfaces. It renders only
    // when summoned (N or the + button). Escape dismisses; blur dismisses when
    // empty. Re-renders rebuild the input, so typed text and focus carry across
    // — mid-typing events (notices, peer updates) never eat the draft. Enter
    // routes through actions.addItem, which files the item on whichever surface
    // (grocery vs to-do) is currently in view.
    function renderAddBar(t) {
        if (!ui.addBarOpen) return null
        const previousAdd = main.querySelector('#add-item-input')
        const addInput = h('input', {
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
        if (previousAdd) {
            addInput.value = previousAdd.value
            if (main.ownerDocument.activeElement === previousAdd) {
                queueMicrotask(() => addInput.focus())
            }
        }
        return h('div', { class: 'add-bar' },
            addInput,
            h('span', { class: 'add-hint label-md' }, t('desktop.addItem.hint')),
        )
    }

    function renderListsPane(state) {
        const t = locale.i18n.t.bind(locale.i18n)
        const { preferences } = state
        const items = state.items.filter(isGroceryItem)
        const summary = selectSummary(items)

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
            renderAddBar(t),
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
            items.length === 0 ? renderEmptyState() : renderItems(state, items),
        )
    }

    // The to-do surface: a flat plain-text list. No category grouping, no grid,
    // no grocery item icons — just checkbox rows. Mirrors the grocery pane but
    // deliberately omits the grid toggle and the category machinery.
    function renderTodoPane(state) {
        const t = locale.i18n.t.bind(locale.i18n)
        const items = state.items.filter(isTodoItem)
        const summary = selectSummary(items)
        const statusKey = !state.backendReady
            ? 'header.status.starting'
            : state.peerCount > 0 ? 'header.status.synced' : 'header.status.ready'

        replaceChildren(main,
            h('header', { class: 'page-header' },
                h('h1', { class: 'page-title title-lg' }, t('desktop.rail.todo')),
                h('div', { class: 'header-actions' },
                    h('button', {
                        class: 'btn btn-secondary btn-icon',
                        'aria-label': t('desktop.header.addItem'),
                        title: `${t('desktop.header.addItem')} (N)`,
                        onclick: actions.summonAddBar,
                    }, tablerIcon('plus', { size: 16 })),
                    h('button', { class: 'btn btn-critical', onclick: actions.share }, t('desktop.header.share')),
                ),
            ),
            renderAddBar(t),
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
            items.length === 0
                ? renderEmptyState()
                : h('div', { class: 'item-rows' },
                    ...items.map((item) => renderItemRow(item, tablerIcon(item.isDone ? 'square-check' : 'square', { size: 18 }))),
                ),
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

    function renderItems(state, items) {
        const { preferences } = state
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
                    : h('div', { class: 'item-rows' }, ...section.items.map(({ entry }) => renderItemRow(entry, categoryIcon(section.canonicalKey, { size: 16 })))),
            )),
        )
    }

    // `glyph` is the leading icon node: a category icon on the grocery surface,
    // a checkbox on the to-do surface. The row's toggle/edit/delete behaviour is
    // identical for both.
    function renderItemRow(item, glyph) {
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
            h('span', { class: 'glyph' }, glyph),
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

    // The board config is owner-signed shared state held by the backend; fetch
    // it once when a board surface first renders.
    function requestBoardConfigOnce() {
        if (ui.boardConfigRequested) return
        ui.boardConfigRequested = true
        send(RPC_GET_BOARD_CONFIG)
    }

    function ticketInitials(value) {
        const s = String(value || '').replace(/[^a-z0-9]/gi, '')
        return (s.slice(0, 2) || '?').toUpperCase()
    }

    // The ticket selected for the split panel / full doc, or null. Filters by
    // listType so a stale id can never surface a grocery row in the detail view.
    function selectedTicket(state) {
        if (!ui.selectedTicketId) return null
        const item = state.items.find((entry) => entry && entry.id === ui.selectedTicketId)
        return item && isBoardType(item.listType) ? item : null
    }

    // The item's blocks with the in-flight textarea draft folded into the block
    // currently being edited — the value commitBlocks should persist.
    function blocksWithPendingEdit(item) {
        const blocks = normalizeBlocks(item.blocks)
        if (!ui.blockEditingId) return blocks
        return blocks.map((b) => (b.id === ui.blockEditingId ? { ...b, ...blockFromText(b.type, ui.blockDraft) } : b))
    }

    function renderBoardPane(state) {
        const t = locale.i18n.t.bind(locale.i18n)
        requestBoardConfigOnce()
        const config = selectBoardConfig(state)
        const columns = groupByStatus(state.items, config)
        const nowMs = now()
        const board = h('div', { class: 'board-grid' }, ...columns.map((col) => renderBoardColumn(col, nowMs)))
        const selected = selectedTicket(state)
        replaceChildren(main,
            h('header', { class: 'page-header' },
                h('h1', { class: 'page-title title-lg' }, t('board.title')),
                h('div', { class: 'header-actions' },
                    h('button', {
                        class: 'btn btn-secondary btn-icon',
                        'aria-label': t('board.newTicket'),
                        title: t('board.newTicket'),
                        onclick: () => actions.newTicket(),
                    }, tablerIcon('plus', { size: 16 })),
                    h('button', { class: 'btn btn-critical', onclick: actions.share }, t('desktop.header.share')),
                ),
            ),
            selected
                ? h('div', { class: 'board-split' }, board, renderTicketSplitPanel(selected, state))
                : board,
        )
    }

    function renderBoardColumn(col, nowMs) {
        const t = locale.i18n.t.bind(locale.i18n)
        const s = col.state
        const count = s.wipLimit > 0 ? `${col.tickets.length}/${s.wipLimit}` : String(col.tickets.length)
        return h('div', {
            class: 'board-column',
            dataset: { status: s.id },
            ondragover: (event) => { event.preventDefault(); event.currentTarget.classList.add('drag-over') },
            ondragleave: (event) => { event.currentTarget.classList.remove('drag-over') },
            ondrop: (event) => {
                event.preventDefault()
                event.currentTarget.classList.remove('drag-over')
                const drag = ui.boardDrag
                ui.boardDrag = null
                if (!drag || drag.fromStatus === s.id) return
                const item = store.getState().items.find((entry) => entry && entry.id === drag.id)
                if (item) actions.moveTicket(item, s.id)
            },
        },
            h('div', { class: 'board-col-head' },
                h('span', { class: 'board-dot', style: `background:${s.color || 'var(--ink-faint)'}` }),
                h('span', { class: 'board-col-name label-sm' }, s.name),
                h('span', { class: 'board-col-count label-sm' }, count),
            ),
            h('div', { class: 'board-col-body' },
                ...col.tickets.map((ticket) => renderTicketCard(ticket, nowMs)),
                h('button', { class: 'board-add', onclick: () => actions.newTicket() },
                    tablerIcon('plus', { size: 14 }), t('board.add')),
            ),
        )
    }

    function renderTicketCard(item, nowMs) {
        const t = locale.i18n.t.bind(locale.i18n)
        const b = ticketBadges(item, nowMs)
        const chips = []
        if (b.priority) chips.push(h('span', { class: `priority-pill ${b.priority}` }, t(`ticket.priority.${b.priority}`)))
        const meta = []
        if (b.assignee) meta.push(h('span', { class: 'ticket-avatar' }, ticketInitials(b.assignee)))
        if (b.checklistTotal > 0) {
            meta.push(h('span', { class: 'ticket-meta' }, tablerIcon('checklist', { size: 13 }), `${b.checklistDone}/${b.checklistTotal}`))
        }
        if (b.isDone && b.timeliness) {
            const delta = deltaPercent(b.inProgressHours, b.estimatedHours)
            const suffix = delta != null ? ` ${delta > 0 ? '+' : ''}${delta}%` : ''
            meta.push(h('span', { class: `timeliness-badge ${b.timeliness}` }, t(`ticket.timeliness.${b.timeliness}`) + suffix))
        } else if (b.running) {
            meta.push(h('span', { class: 'ticket-timer' },
                h('span', { class: 'timer-dot' }),
                `${formatDuration(b.inProgressMs)}${b.estimatedHours ? ` / ${b.estimatedHours}h` : ''}`))
        }
        return h('article', {
            class: `ticket-card${ui.selectedTicketId === item.id ? ' selected' : ''}`,
            draggable: 'true',
            dataset: { itemId: item.id, status: item.status || 'todo' },
            onclick: () => actions.openTicket(item.id),
            ondragstart: (event) => {
                ui.boardDrag = { id: item.id, fromStatus: item.status || 'todo' }
                event.dataTransfer.effectAllowed = 'move'
                try { event.dataTransfer.setData('text/plain', item.id) } catch { /* some platforms reject */ }
                event.currentTarget.classList.add('dragging')
            },
            ondragend: (event) => { event.currentTarget.classList.remove('dragging'); ui.boardDrag = null },
        },
            h('div', { class: 'ticket-title' }, item.text),
            chips.length ? h('div', { class: 'ticket-chips' }, ...chips) : null,
            meta.length ? h('div', { class: 'ticket-card-meta label-sm' }, ...meta) : null,
        )
    }

    // === Ticket detail =====================================================
    // Three shared pure builders (renderTicketSummary / renderTicketBody /
    // renderPropertyRail) compose into BOTH presentations: the right-hand split
    // panel (board stays on the left) and the full-screen document view.

    // A borderless field that survives the wholesale re-render: an in-progress
    // value + focus are restored from the previous same-id element (the add-bar
    // pattern), and the deferred blur-commit bails when a re-render kept focus,
    // so a background store update never eats a half-typed title.
    function editableText({ id, value, placeholder = '', multiline = false, className = '', onCommit }) {
        const prev = root.querySelector(`#${id}`)
        const el = h(multiline ? 'textarea' : 'input', {
            id,
            class: className,
            placeholder,
            rows: multiline ? '2' : null,
            onkeydown: (event) => {
                if (event.key === 'Escape') { event.stopPropagation(); el.value = value; el.blur(); return }
                if (event.key === 'Enter' && (!multiline || event.metaKey || event.ctrlKey)) { event.preventDefault(); el.blur() }
            },
            onblur: () => queueMicrotask(() => {
                const live = root.querySelector(`#${id}`)
                if (live && live !== el && main.ownerDocument.activeElement === live) return
                if (el.value !== value) onCommit(el.value)
            }),
        })
        el.value = value
        if (prev) {
            el.value = prev.value
            if (main.ownerDocument.activeElement === prev) {
                queueMicrotask(() => { el.focus(); const p = el.value.length; try { el.setSelectionRange(p, p) } catch { /* number/date inputs reject */ } })
            }
        }
        return el
    }

    function renderTicketSummary(item, state, { full = false } = {}) {
        const t = locale.i18n.t.bind(locale.i18n)
        const b = ticketBadges(item, now())
        const config = selectBoardConfig(state)
        const stateName = config.states.find((s) => s.id === item.status)?.name || item.status || t('ticket.detail.none')
        const chips = [h('span', { class: 'role-chip' }, stateName)]
        if (b.priority) chips.push(h('span', { class: `priority-pill ${b.priority}` }, t(`ticket.priority.${b.priority}`)))
        if (b.isDone && b.timeliness) {
            const d = deltaPercent(b.inProgressHours, b.estimatedHours)
            chips.push(h('span', { class: `timeliness-badge ${b.timeliness}` }, t(`ticket.timeliness.${b.timeliness}`) + (d != null ? ` ${d > 0 ? '+' : ''}${d}%` : '')))
        } else if (b.running) {
            chips.push(h('span', { class: 'ticket-timer' }, h('span', { class: 'timer-dot' }), `${formatDuration(b.inProgressMs)}${b.estimatedHours ? ` / ${b.estimatedHours}h` : ''}`))
        }
        const meta = []
        if (b.estimatedHours) meta.push(h('span', { class: 'sm-meta' }, `${t('ticket.detail.estimate')} ${b.estimatedHours}h`))
        if (item.estimatedComplexity) meta.push(h('span', { class: 'sm-meta' }, `${t('ticket.detail.complexity')} ${item.estimatedComplexity}%`))
        if (b.inProgressMs > 0) meta.push(h('span', { class: 'sm-meta' }, `${t('ticket.detail.timeSpent')} ${formatDuration(b.inProgressMs)}`))
        // The rigor task checklist is a top-level field (distinct from body
        // blocks); surface it so the done-gate stays toggleable from the detail.
        const checklist = Array.isArray(item.checklist) ? item.checklist : []
        return h('div', { class: `ticket-summary${full ? ' full' : ''}` },
            h('div', { class: 'ticket-summary-chips' }, ...chips),
            editableText({
                id: 'tf-title',
                value: item.text || '',
                placeholder: t('ticket.detail.titlePlaceholder'),
                className: 'ticket-title-field',
                onCommit: (v) => { const nv = v.trim(); if (nv && nv !== item.text) actions.updateTicket(item, { text: nv }) },
            }),
            editableText({
                id: 'tf-desc',
                value: item.description || '',
                placeholder: t('ticket.detail.descriptionPlaceholder'),
                multiline: true,
                className: 'ticket-desc-field',
                onCommit: (v) => { if (v !== (item.description || '')) actions.updateTicket(item, { description: v }) },
            }),
            meta.length ? h('div', { class: 'ticket-summary-meta label-sm' }, ...meta) : null,
            checklist.length ? h('div', { class: 'ticket-summary-tasks' },
                h('h3', { class: 'category-heading label-sm' }, t('ticket.detail.tasks')),
                h('div', { class: 'detail-checklist' }, ...checklist.map((task) => h('label', { class: `detail-task${task.done ? ' done' : ''}` },
                    h('input', { type: 'checkbox', checked: task.done ? '' : null, onchange: () => actions.toggleTicketTask(item, task.id) }),
                    h('span', {}, task.text),
                ))),
            ) : null,
        )
    }

    function propRow(icon, label, control) {
        return h('div', { class: 'prop-row' },
            h('span', { class: 'prop-key label-sm' }, icon, h('span', {}, label)),
            h('span', { class: 'prop-val' }, control),
        )
    }

    function toDateInputValue(ms) {
        try {
            const d = new Date(ms)
            const pad = (n) => String(n).padStart(2, '0')
            return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
        } catch { return '' }
    }
    function fromDateInputValue(v) {
        if (!v) return 0
        const ms = Date.parse(`${v}T00:00:00`)
        return Number.isFinite(ms) ? ms : 0
    }
    function clampComplexity(v) {
        if (v === '' || v == null) return 0
        const n = Math.round(Number(v))
        if (!Number.isFinite(n)) return 0
        return Math.min(100, Math.max(1, n))
    }

    function renderPropertyRail(item, state) {
        const t = locale.i18n.t.bind(locale.i18n)
        const config = selectBoardConfig(state)
        const b = ticketBadges(item, now())
        const writers = state.roster?.writers ?? []

        const shared = h('div', { class: 'prop-shared' },
            h('h3', { class: 'category-heading label-sm' }, tablerIcon('share', { size: 13 }), h('span', {}, t('ticket.detail.sharedWith'))),
            writers.length === 0
                ? h('p', { class: 'label-sm prop-empty' }, t('ticket.detail.you'))
                : h('div', { class: 'prop-avatars' }, ...writers.map((w) => h('span', { class: 'ticket-avatar', title: w.writerKey }, ticketInitials(w.writerKey)))),
        )

        const statusSel = h('select', { class: 'prop-select', onchange: (event) => actions.moveTicket(item, event.target.value) },
            ...config.states.map((s) => h('option', { value: s.id }, s.name)))
        statusSel.value = item.status || (config.states[0] && config.states[0].id) || ''

        const prioritySel = h('select', { class: 'prop-select', onchange: (event) => actions.updateTicket(item, { priority: event.target.value }) },
            h('option', { value: '' }, t('ticket.priority.none')),
            ...['low', 'medium', 'high', 'urgent'].map((p) => h('option', { value: p }, t(`ticket.priority.${p}`))))
        prioritySel.value = item.priority || ''

        const assigneeSel = h('select', { class: 'prop-select', onchange: (event) => actions.updateTicket(item, { assignee: event.target.value }) },
            h('option', { value: '' }, t('ticket.detail.none')),
            ...writers.map((w) => h('option', { value: w.writerKey }, w.writerKey.slice(0, 8))))
        assigneeSel.value = item.assignee || ''

        const dueInput = h('input', { type: 'date', class: 'prop-input', onchange: (event) => actions.updateTicket(item, { dueAt: fromDateInputValue(event.target.value) }) })
        dueInput.value = item.dueAt ? toDateInputValue(item.dueAt) : ''
        const estInput = h('input', { type: 'number', min: '0', step: '0.25', class: 'prop-input', onchange: (event) => actions.updateTicket(item, { estimatedHours: Number(event.target.value) || 0 }) })
        estInput.value = item.estimatedHours != null ? String(item.estimatedHours) : ''
        const cxInput = h('input', { type: 'number', min: '1', max: '100', class: 'prop-input', onchange: (event) => actions.updateTicket(item, { estimatedComplexity: clampComplexity(event.target.value) }) })
        cxInput.value = item.estimatedComplexity != null ? String(item.estimatedComplexity) : ''

        const rows = [
            propRow(tablerIcon('layout-columns', { size: 14 }), t('ticket.detail.status'), statusSel),
            propRow(tablerIcon('flag', { size: 14 }), t('ticket.detail.priority'), prioritySel),
            propRow(tablerIcon('user', { size: 14 }), t('ticket.detail.assignee'), assigneeSel),
            propRow(tablerIcon('calendar', { size: 14 }), t('ticket.detail.due'), dueInput),
            propRow(tablerIcon('clock', { size: 14 }), t('ticket.detail.estimate'), estInput),
            propRow(tablerIcon('activity', { size: 14 }), t('ticket.detail.complexity'), cxInput),
            propRow(tablerIcon('clock', { size: 14 }), t('ticket.detail.timeSpent'), h('span', { class: 'prop-readonly' }, formatDuration(b.inProgressMs))),
        ]
        if (b.isDone && b.timeliness) {
            const d = deltaPercent(b.inProgressHours, b.estimatedHours)
            rows.push(propRow(tablerIcon('flag', { size: 14 }), t('ticket.detail.timeliness'),
                h('span', { class: `timeliness-badge ${b.timeliness}` }, t(`ticket.timeliness.${b.timeliness}`) + (d != null ? ` ${d > 0 ? '+' : ''}${d}%` : ''))))
        }
        if (item.createdBy) {
            rows.push(propRow(tablerIcon('user', { size: 14 }), t('ticket.detail.createdBy'),
                h('span', { class: 'ticket-avatar', title: item.createdBy }, ticketInitials(item.createdBy))))
        }

        return h('div', { class: 'prop-rail-inner' },
            shared,
            h('div', { class: 'prop-section' },
                h('h3', { class: 'category-heading label-sm' }, t('ticket.detail.properties')),
                h('div', { class: 'prop-rows' }, ...rows),
            ),
        )
    }

    // --- block body ---------------------------------------------------------
    const SAFE_URL = /^(https?:\/\/|mailto:)/i
    const SAFE_IMG = /^(https?:\/\/|data:image\/)/i

    function blockMutedView(text, onclick) {
        return h('div', { class: 'block-md muted', onclick }, text)
    }

    function renderBlockView(item, block) {
        const t = locale.i18n.t.bind(locale.i18n)
        const edit = () => actions.startBlockEdit(item, block)
        switch (block.type) {
            case 'callout': {
                const body = h('div', { class: 'block-md' })
                body.innerHTML = renderInlineMarkdown(block.text || '')
                if (!(block.text || '').trim()) return blockMutedView(t('ticket.block.placeholder.callout'), edit)
                return h('div', { class: 'block-callout', onclick: edit }, tablerIcon('quote', { size: 16 }), body)
            }
            case 'code':
                return h('pre', { class: 'block-code', onclick: edit }, h('code', {}, block.text || ''))
            case 'checklist': {
                const items = Array.isArray(block.items) ? block.items : []
                if (!items.length) return blockMutedView(t('ticket.block.placeholder.checklist'), edit)
                return h('ul', { class: 'block-checklist' }, ...items.map((it, i) => h('li', { class: it.done ? 'done' : '', onclick: edit },
                    h('input', { type: 'checkbox', checked: it.done ? '' : null, onclick: (e) => e.stopPropagation(), onchange: () => actions.toggleChecklistBlockItem(item, block.id, i) }),
                    h('span', {}, it.text || ''),
                )))
            }
            case 'numberedList': {
                const items = Array.isArray(block.items) ? block.items : []
                if (!items.length) return blockMutedView(t('ticket.block.placeholder.numberedList'), edit)
                return h('ol', { class: 'block-numbered', onclick: edit }, ...items.map((it) => h('li', {}, it.text || '')))
            }
            case 'links': {
                const links = Array.isArray(block.links) ? block.links : []
                if (!links.length) return blockMutedView(t('ticket.block.placeholder.links'), edit)
                return h('ul', { class: 'block-links' }, ...links.map((l) => {
                    const label = l.label || l.url || ''
                    return h('li', {}, SAFE_URL.test(l.url || '')
                        ? h('a', { href: l.url, target: '_blank', rel: 'noopener noreferrer', onclick: (e) => e.stopPropagation() }, tablerIcon('link', { size: 13 }), label)
                        : h('span', { onclick: edit }, label))
                }))
            }
            case 'image':
                if (!block.url || !SAFE_IMG.test(block.url)) return blockMutedView(t('ticket.block.imageEmpty'), edit)
                return h('img', { class: 'block-image', src: block.url, alt: block.alt || '', loading: 'lazy', onclick: edit })
            case 'table': {
                const rows = Array.isArray(block.rows) ? block.rows : []
                if (!rows.length) return blockMutedView(t('ticket.block.placeholder.table'), edit)
                const [head, ...body] = rows
                return h('table', { class: 'block-table', onclick: edit },
                    h('thead', {}, h('tr', {}, ...(head || []).map((c) => h('th', {}, c)))),
                    h('tbody', {}, ...body.map((r) => h('tr', {}, ...(r || []).map((c) => h('td', {}, c))))),
                )
            }
            default: {
                const text = block.text || ''
                if (!text.trim()) return blockMutedView(t('ticket.block.placeholder.markdown'), edit)
                const div = h('div', { class: 'block-md', onclick: edit })
                div.innerHTML = renderMarkdownBlock(text)
                return div
            }
        }
    }

    function renderSlashMenu(item, spec) {
        const t = locale.i18n.t.bind(locale.i18n)
        return h('div', { class: 'block-slash-menu', role: 'menu' },
            ...BLOCK_TYPES.map((bt) => h('button', {
                class: 'slash-item',
                type: 'button',
                role: 'menuitem',
                onmousedown: (event) => event.preventDefault(),
                onclick: () => {
                    if (spec.mode === 'replace') actions.replaceBlock(item, spec.blockId, bt.type)
                    else actions.insertBlock(item, bt.type, spec.mode === 'after' ? spec.blockId : null)
                },
            }, tablerIcon(bt.icon, { size: 15 }), h('span', { class: 'label-md' }, t(bt.labelKey)))),
        )
    }

    function renderBlockEditor(item, block) {
        const t = locale.i18n.t.bind(locale.i18n)
        const placeholder = t(`ticket.block.placeholder.${block.type}`)
        // Markdown blocks get an inline "/" command menu, toggled purely via
        // classList so a keystroke never forces a re-render that would steal the
        // textarea focus.
        const menu = block.type === 'markdown' ? renderSlashMenu(item, { mode: 'replace', blockId: block.id }) : null
        if (menu) menu.classList.add('block-slash-inline', ui.blockDraft === '/' ? 'open' : 'hidden')
        const ta = h('textarea', {
            class: 'block-editor',
            rows: (block.type === 'markdown' || block.type === 'code' || block.type === 'callout' || block.type === 'table') ? '4' : '3',
            placeholder,
            oninput: (event) => {
                ui.blockDraft = event.target.value
                if (menu) menu.classList.toggle('hidden', event.target.value !== '/')
                if (menu) menu.classList.toggle('open', event.target.value === '/')
            },
            onkeydown: (event) => {
                if (event.key === 'Escape') { event.stopPropagation(); actions.cancelBlockEdit(); return }
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); actions.commitBlockEdit(item) }
            },
            onblur: () => queueMicrotask(() => {
                const live = root.querySelector('.block-editor')
                if (live && live !== ta && main.ownerDocument.activeElement === live) return
                if (ui.blockEditingId === block.id) actions.commitBlockEdit(item)
            }),
        })
        ta.value = ui.blockDraft
        queueMicrotask(() => {
            if (main.ownerDocument.activeElement === ta) return
            ta.focus()
            const p = ta.value.length
            try { ta.setSelectionRange(p, p) } catch { /* ignore */ }
        })
        return h('div', { class: 'block-editor-wrap' }, ta, menu)
    }

    function renderBlock(item, block) {
        const t = locale.i18n.t.bind(locale.i18n)
        const editing = ui.blockEditingId === block.id
        const afterMenu = (!editing && ui.blockMenu && ui.blockMenu.mode === 'after' && ui.blockMenu.blockId === block.id)
            ? h('div', { class: 'block-menu-anchor' }, h('div', { class: 'block-menu-scrim', onclick: () => actions.closeBlockMenu() }), renderSlashMenu(item, ui.blockMenu))
            : null
        const row = h('div', {
            class: `block block-${block.type}${editing ? ' editing' : ''}`,
            dataset: { blockId: block.id },
            ondragover: (event) => { if (ui.blockDrag) { event.preventDefault(); row.classList.add('block-drop') } },
            ondragleave: () => row.classList.remove('block-drop'),
            ondrop: (event) => {
                event.preventDefault()
                row.classList.remove('block-drop')
                const drag = ui.blockDrag
                ui.blockDrag = null
                if (drag) actions.moveBlock(item, drag.id, block.id)
            },
        },
            h('div', { class: 'block-gutter' },
                h('button', {
                    class: 'block-handle',
                    type: 'button',
                    draggable: 'true',
                    'aria-label': t('ticket.block.move'),
                    ondragstart: (event) => {
                        ui.blockDrag = { id: block.id }
                        event.dataTransfer.effectAllowed = 'move'
                        try { event.dataTransfer.setData('text/plain', block.id) } catch { /* some platforms reject */ }
                        row.classList.add('block-dragging')
                    },
                    ondragend: () => { ui.blockDrag = null; row.classList.remove('block-dragging') },
                }, tablerIcon('grip-vertical', { size: 15 })),
                h('button', {
                    class: 'block-plus',
                    type: 'button',
                    'aria-label': t('ticket.block.insert'),
                    onclick: () => actions.openBlockMenu({ mode: 'after', blockId: block.id }),
                }, tablerIcon('plus', { size: 15 })),
            ),
            h('div', { class: 'block-content' }, editing ? renderBlockEditor(item, block) : renderBlockView(item, block)),
            h('button', {
                class: 'block-delete',
                type: 'button',
                'aria-label': t('ticket.block.delete'),
                onclick: () => actions.deleteBlock(item, block.id),
            }, tablerIcon('trash', { size: 14 })),
            afterMenu,
        )
        return row
    }

    function renderTicketBody(item) {
        const t = locale.i18n.t.bind(locale.i18n)
        const blocks = normalizeBlocks(item.blocks)
        const addMenuOpen = !!(ui.blockMenu && ui.blockMenu.mode === 'end')
        return h('section', { class: 'ticket-body' },
            h('div', { class: 'ticket-body-head' },
                h('h3', { class: 'category-heading label-sm' }, t('ticket.detail.body')),
                blocks.length ? h('span', { class: 'block-hint label-sm' }, t('ticket.block.editHint')) : null,
            ),
            blocks.length === 0
                ? h('button', { class: 'block-empty', type: 'button', onclick: () => actions.openBlockMenu({ mode: 'end' }) }, tablerIcon('plus', { size: 16 }), t('ticket.block.empty'))
                : h('div', { class: 'ticket-blocks' }, ...blocks.map((b) => renderBlock(item, b))),
            h('div', { class: 'block-add-row' },
                h('button', { class: 'block-add', type: 'button', onclick: () => actions.openBlockMenu({ mode: 'end' }) }, tablerIcon('plus', { size: 14 }), t('ticket.block.add')),
                addMenuOpen ? h('div', { class: 'block-menu-anchor end' }, h('div', { class: 'block-menu-scrim', onclick: () => actions.closeBlockMenu() }), renderSlashMenu(item, { mode: 'end' })) : null,
            ),
        )
    }

    function renderTicketSplitPanel(item, state) {
        const t = locale.i18n.t.bind(locale.i18n)
        return h('aside', { class: 'detail-split' },
            h('div', { class: 'detail-toolbar' },
                h('button', { class: 'btn btn-secondary btn-icon', type: 'button', 'aria-label': t('ticket.detail.openFull'), title: t('ticket.detail.openFull'), onclick: () => actions.promoteTicket(item.id) }, tablerIcon('arrows-maximize', { size: 15 })),
                h('button', { class: 'btn btn-secondary btn-icon', type: 'button', 'aria-label': t('ticket.detail.close'), title: t('ticket.detail.close'), onclick: () => actions.closeTicket() }, tablerIcon('x', { size: 16 })),
            ),
            h('div', { class: 'detail-split-scroll' },
                renderTicketSummary(item, state, { full: false }),
                h('div', { class: 'prop-rail compact' }, renderPropertyRail(item, state)),
                renderTicketBody(item),
            ),
        )
    }

    function renderTicketFull(state) {
        const t = locale.i18n.t.bind(locale.i18n)
        requestBoardConfigOnce()
        const item = state.items.find((entry) => entry && entry.id === ui.ticketDocId)
        if (!item || !isBoardType(item.listType)) {
            ui.ticketDocId = null
            return ui.view === 'board' ? renderBoardPane(state) : renderListsPane(state)
        }
        replaceChildren(main,
            h('header', { class: 'page-header ticket-doc-header' },
                h('button', { class: 'btn btn-secondary', type: 'button', onclick: () => actions.collapseTicket() }, tablerIcon('arrows-minimize', { size: 15 }), t('ticket.detail.exitFull')),
                h('div', { class: 'header-actions' },
                    h('button', { class: 'btn btn-secondary btn-icon', type: 'button', 'aria-label': t('ticket.detail.close'), title: t('ticket.detail.close'), onclick: () => actions.closeTicket() }, tablerIcon('x', { size: 16 })),
                ),
            ),
            h('div', { class: 'ticket-doc' },
                h('div', { class: 'ticket-doc-summary' }, renderTicketSummary(item, state, { full: true })),
                h('aside', { class: 'ticket-doc-rail prop-rail' }, renderPropertyRail(item, state)),
                h('div', { class: 'ticket-doc-body' }, renderTicketBody(item)),
            ),
        )
    }

    function renderCongruencyPane(state) {
        const t = locale.i18n.t.bind(locale.i18n)
        requestBoardConfigOnce()
        const stats = selectWriterStats(state.items)
        const legend = (cls, label) => h('span', { class: 'lg' }, h('span', { class: `sw ${cls}` }), label)
        replaceChildren(main,
            h('header', { class: 'page-header' },
                h('h1', { class: 'page-title title-lg' }, t('congruency.title')),
            ),
            h('section', { class: 'pane-section' },
                h('p', { class: 'body-md', style: 'color: var(--secondary); padding: 0 1rem;' }, t('congruency.subtitle')),
                stats.length === 0
                    ? h('p', { class: 'body-md', style: 'color: var(--secondary); padding: 0 1rem;' }, t('congruency.empty'))
                    : h('div', { class: 'congruency-cards' }, ...stats.map(renderCongruencyCard)),
                stats.length
                    ? h('div', { class: 'congruency-legend label-sm' },
                        legend('on-time', t('congruency.legend.onTime')),
                        legend('over', t('congruency.legend.overtime')),
                        legend('under', t('congruency.legend.undertime')))
                    : null,
            ),
        )
    }

    function renderCongruencyCard(stat) {
        const t = locale.i18n.t.bind(locale.i18n)
        const total = Math.max(1, stat.count)
        const name = stat.user === 'unassigned' ? '—' : stat.user.slice(0, 8)
        return h('div', { class: 'congruency-card' },
            h('div', { class: 'congruency-user' },
                h('span', { class: 'ticket-avatar' }, ticketInitials(stat.user)),
                h('div', {},
                    h('div', { class: 'body-md' }, name),
                    h('div', { class: 'label-sm', style: 'color: var(--secondary);' }, t('congruency.completed', { count: stat.count })),
                ),
            ),
            h('div', { class: 'congruency-mid' },
                h('div', { class: 'congruency-bar' },
                    h('span', { class: 'seg on-time', style: `width:${(100 * stat.onTime / total)}%` }),
                    h('span', { class: 'seg over', style: `width:${(100 * stat.over / total)}%` }),
                    h('span', { class: 'seg under', style: `width:${(100 * stat.under / total)}%` }),
                ),
                h('div', { class: 'congruency-math label-sm' },
                    `${t('congruency.stat.avgComplexity')} ${stat.avgComplexity}% · ${t('congruency.stat.offEstimate')} ${stat.offEstimateRate}% · ${t('congruency.stat.gap')} ${stat.gap}`),
            ),
            h('div', { class: 'congruency-score-box' },
                h('div', { class: 'congruency-score' }, `${stat.score}%`),
                h('span', { class: `tendency ${stat.tendency}` }, t(`congruency.tendency.${stat.tendency}`)),
            ),
        )
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
            const boardCfg = selectBoardConfig(state)
            const canEditRigor = !!(state.boardConfigCanAdminister || state.roster?.canAdminister)
            const rigorRow = canEditRigor
                ? h('div', { class: 'choice-row' },
                    h('button', {
                        class: `btn ${boardCfg.rigorOn ? 'btn-primary' : 'btn-secondary'}`,
                        'aria-pressed': boardCfg.rigorOn ? 'true' : 'false',
                        onclick: () => actions.setRigor(true),
                    }, t('settings.rigor.on')),
                    h('button', {
                        class: `btn ${!boardCfg.rigorOn ? 'btn-primary' : 'btn-secondary'}`,
                        'aria-pressed': !boardCfg.rigorOn ? 'true' : 'false',
                        onclick: () => actions.setRigor(false),
                    }, t('settings.rigor.off')),
                )
                : h('p', { class: 'body-md', style: 'color: var(--secondary);' },
                    `${boardCfg.rigorOn ? t('settings.rigor.on') : t('settings.rigor.off')} — ${t('settings.rigor.readonlyHelp')}`)
            content = dialogFrame(t('desktop.settings.title'), [
                h('h3', { class: 'category-heading label-sm' }, t('desktop.theme.label')),
                themeRow,
                h('h3', { class: 'category-heading label-sm' }, t('desktop.hints.show')),
                hintsRow,
                h('h3', { class: 'category-heading label-sm' }, t('settings.rigor.label')),
                rigorRow,
                canEditRigor ? h('p', { class: 'label-md', style: 'color: var(--secondary);' }, t('settings.rigor.ownerHelp')) : null,
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
        } else if (kind === 'add-ticket') {
            const config = selectBoardConfig(state)
            const rigorOn = config.rigorOn
            const draft = ui.dialog.draft
            const descInput = h('input', { class: 'input', value: draft.description, placeholder: t('ticket.field.descriptionPlaceholder'), oninput: (event) => { draft.description = event.target.value } })
            const hoursInput = h('input', { class: 'input', type: 'number', min: '0.25', step: '0.25', style: 'max-width: 130px;', value: draft.hours, placeholder: '6', oninput: (event) => { draft.hours = event.target.value } })
            const cxReadout = h('span', { class: 'complexity-readout label-md' }, `${draft.complexity}%`)
            const cxInput = h('input', { type: 'range', min: '1', max: '100', value: String(draft.complexity), class: 'complexity-slider', oninput: (event) => { draft.complexity = Number(event.target.value); cxReadout.textContent = `${draft.complexity}%` } })
            const taskRows = draft.tasks.map((val, index) => h('div', { class: 'rigor-task-row' },
                h('input', { class: 'input', value: val, placeholder: t('ticket.field.taskPlaceholder'), oninput: (event) => { draft.tasks[index] = event.target.value } }),
                h('button', { class: 'btn btn-secondary btn-icon', 'aria-label': t('common.remove'), onclick: () => { draft.tasks.splice(index, 1); if (!draft.tasks.length) draft.tasks.push(''); renderAll() } }, tablerIcon('x', { size: 14 })),
            ))
            const submit = () => {
                const desc = draft.description.trim()
                const tasks = draft.tasks.map((s) => s.trim()).filter(Boolean)
                const hours = Number(draft.hours)
                const complexity = Number(draft.complexity)
                const checklist = tasks.map((text, index) => ({ id: `task-${index}-${text.length}-${complexity}`, text, done: false }))
                const missing = []
                if (!desc) missing.push('description')
                if (rigorOn) {
                    for (const m of validateRigorDraft({ text: desc, description: desc, checklist, estimatedHours: hours, estimatedComplexity: complexity }, config).missing) {
                        if (!missing.includes(m)) missing.push(m)
                    }
                }
                if (missing.length) {
                    store.pushNotice(t('ticket.create.missing'), 'error')
                    if (missing.includes('description')) shake(descInput)
                    if (missing.includes('hours')) shake(hoursInput)
                    return
                }
                markLocalText(desc)
                send(RPC_ADD, { text: desc, listType: BOARD_WRITE_TYPE, status: 'todo', description: desc, checklist, estimatedHours: hours, estimatedComplexity: complexity })
                closeDialog()
            }
            content = dialogFrame(t('ticket.create.title'), [
                rigorOn ? h('div', { class: 'rigor-badge' }, tablerIcon('checklist', { size: 13 }), t('ticket.create.rigorBadge')) : null,
                rigorOn ? h('p', { class: 'dialog-body', style: 'color: var(--secondary);' }, t('ticket.create.rigorHint')) : null,
                fieldLabel(t('ticket.field.description'), rigorOn),
                descInput,
                fieldLabel(t('ticket.field.tasks'), rigorOn),
                h('div', { class: 'rigor-tasks' }, ...taskRows),
                h('button', { class: 'btn btn-secondary add-task', onclick: () => { draft.tasks.push(''); renderAll() } }, tablerIcon('plus', { size: 14 }), t('ticket.field.addTask')),
                h('div', { class: 'rigor-2col' },
                    h('div', {}, fieldLabel(t('ticket.field.hours'), rigorOn), hoursInput),
                    h('div', {}, fieldLabel(t('ticket.field.complexity'), rigorOn), h('div', { class: 'complexity-row' }, cxInput, cxReadout)),
                ),
                rigorOn ? h('p', { class: 'label-md', style: 'color: var(--secondary);' }, t('ticket.rigor.ownerNote')) : null,
            ], [
                h('button', { class: 'btn btn-secondary', onclick: closeDialog }, t('common.cancel')),
                h('button', { class: 'btn btn-primary', onclick: submit }, t('ticket.create.submit')),
            ])
            queueMicrotask(() => descInput.focus())
        }

        replaceChildren(dialogHost,
            h('div', { class: 'dialog-backdrop', onclick: (event) => { if (event.target === event.currentTarget) closeDialog() } }, content),
        )
    }

    function fieldLabel(text, required) {
        return h('label', { class: 'field-label label-sm' }, text, required ? h('span', { class: 'req' }, ' *') : null)
    }

    function shake(el) {
        if (!el) return
        el.classList.remove('shake')
        void el.offsetWidth
        el.classList.add('shake')
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
            if (ui.dialog) { closeDialog(); return }
            if (ui.blockMenu) { actions.closeBlockMenu(); return }
            if (ui.ticketDocId || ui.selectedTicketId) { actions.closeTicket(); return }
            return
        }
        if (isTypingTarget(event.target) || ui.dialog) return

        if (event.key === 'n' || event.key === '/') {
            event.preventDefault()
            actions.summonAddBar()
        } else if (event.key === 'g') {
            // Grid view exists only on the grocery surface; ignore elsewhere.
            if (ui.view === 'lists') preferencesToggle('isGridView')
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
