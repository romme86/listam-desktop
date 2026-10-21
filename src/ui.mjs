import { createInvitePanel, renderInvitePanel } from './ui/invite-panel.mjs'
// Desktop UI: a fixed sidebar plus three panes (lists, peers & devices,
// diagnostics), rendered with plain DOM against the kinetic-minimalist tokens
// in app.css. All user-facing copy resolves through the shared @listam/i18n
// catalogs; all backend interaction goes through the injected client's
// RPC command surface — the same numbers the mobile worklet uses.
import {
    RPC_ADD,
    RPC_UPDATE,
    RPC_DELETE,
    RPC_MOVE,
    RPC_JOIN_KEY,
    RPC_CREATE_INVITE,
    RPC_GET_KEY,
    RPC_CANCEL_JOIN,
    RPC_GET_NET_DIAGNOSTICS,
    RPC_REQUEST_SYNC,
    RPC_REMOVE_MEMBER,
    RPC_GET_MEMBERS,
    RPC_RECOVER_STORAGE,
    RPC_GET_BOARD_CONFIG,
    RPC_SET_BOARD_CONFIG,
    RPC_EXPORT_DATA,
    RPC_EXPORT_SEED,
    RPC_IMPORT,
    RPC_LIST_BACKUPS,
    RPC_RESTORE_BACKUP,
    RPC_SET_BACKUP_PASSWORD,
    RPC_SET_BACKUP_SCHEDULE,
    RPC_SHARE_LIST,
    RPC_JOIN_LIST,
    createInviteQrPayload,
} from '@listam/protocol'
import { groupByCategory, getDisplayCategoryName } from '@listam/grocery'
import { LEAF_EXPERIMENT_ENABLED } from '@listam/domain'
import {
    SERVICE_UUID,
    CHAR_CONFIG_UUID,
    CHAR_STATUS_UUID,
    buildProvisioningPayload,
    provisionLeaf,
} from '@listam/provisioning'
import { DEFAULT_LIST_ID, DEFAULT_LIST_TYPE, isTodoType, TODO_LIST_TYPE, isNotesType, NOTES_LIST_TYPE } from '@listam/domain/identity'
import { computeReorder, sortByOrder } from '@listam/domain/ordering'
import { listAccess } from './ui/list-access.mjs'
import { connectionStatusKey, syncBeaconState } from './ui/connection-status.mjs'
import { reduceRegistry, isListNameTaken } from '@listam/domain/list-registry'
import {
    shortKey,
    ticketInitials,
    nameInitials,
    formatAgo,
    formatUptime,
    isDeviceOnline,
    resolvePeerDisplay,
    presenceStatusVerdict,
} from '@listam/domain/peer-display'
import {
    surfaceLabelKey,
    buildSurfaceLabelItem,
    buildPeerLabelItem,
    buildBuiltinGroupItem,
    buildBuiltinVisibilityItem,
    buildValueReturnItem,
    reduceSurfaceLabels,
    reducePeerLabels,
    reduceBuiltinGroups,
    reduceValueReturn,
} from '@listam/domain/labels'
import {
    reducePresence,
    averageOnlineMs,
} from '@listam/domain/presence'
import {
    VALUE_MIN,
    VALUE_MAX,
    clampRate,
    hasValueRating,
    validateValueDraft,
} from '@listam/domain/value'
import {
    reducePlan,
    computePlanReorder,
    computePlanInsert,
    buildItemPlanEntry,
    buildListPlanEntry,
    buildPlanItem,
    planItemKey,
    planListKey,
    toDateKey,
    shiftDateKey,
} from '@listam/domain/plan'
import {
    newListMeta,
    newGroupMeta,
    patchListMeta,
    patchGroupMeta,
    deleteListMeta,
    deleteGroupMeta,
    nextListOrder,
    nextGroupOrder,
    detectExtraLists,
    visibleBuiltinSurfaceTypes,
} from './registry.mjs'
import { h, replaceChildren } from './dom.mjs'
import { createInviteQr } from './qr-code.mjs'
import { createServersSection } from './ui/servers.mjs'
import { createBackupOps } from './ui/backup.mjs'
import { createCompactionOps } from './ui/compaction.mjs'
import { createOverviewSection } from './ui/overview.mjs'
import { renderPlanCalendar } from './ui/plan-calendar.mjs'
import { createDialogDomState } from './ui/dialog-dom-state.mjs'
import { createSurfaceDomState } from './ui/surface-dom-state.mjs'
import { isEmptyBlock, cleanBlockDraft, renderStructuredBlockEditor } from './ui/structured-block-editor.mjs'
import {
    surfaceForType,
    iconForType,
    typePredicate,
    builtinFallbackKey,
    isGroceryItem,
    isTodoItem,
    isNotesItem,
} from './ui/list-types.mjs'
import { isArchivedNote, noteBlockCount, noteExcerpt, projectNotes } from './ui/notes.mjs'
import { shouldHandleAppShortcut, isTypingKeystroke, isTypingTarget } from './ui/keyboard-shortcuts.mjs'
import {
    emptyTicketDraft,
    ticketDraftFromItem,
    ticketDraftChecklist,
    ticketDraftFields,
    ticketDraftMissing,
    planTicketDraftSettlement,
} from './ui/ticket-draft.mjs'
import { adoptSharedListRoute } from './ui/shared-route.mjs'
import {
    joinErrorKey,
    canCancelJoin,
    describeJoinProgress,
    describeInvite,
    describeNetDiagnostics,
} from './ui/pairing-status.mjs'
import { selectSummary, selectDoneItems } from './store.mjs'
import { buildUndoEntry, applyInverseWrite, guardOk, pushCapped } from './undo.mjs'
import { categoryIcon, tablerIcon } from './icons.mjs'
import { LOCALE_CHOICES, localeChoiceLabel } from './i18n.mjs'
import { nextTheme, THEME_CHOICES } from './prefs.mjs'
import { normalizeLeafBridgePort } from './leaf-bridge-config.mjs'
import {
    isBoardType,
    BOARD_WRITE_TYPE,
    BOARD_LIST_TYPE,
    selectBoardConfig,
    doneStatusesOf,
    groupByStatus,
    ticketBadges,
    buildTicketCardModel,
    dueLabel,
    blockShorthand,
    slashQuery,
    splitAtCaret,
    selectWriterStats,
    validateRigorDraft,
    buildStatusChange,
    buildDraftTicket,
    isDraftTicket,
    canMoveTicket,
    commitDraftTicket,
    formatDuration,
    deltaPercent,
    BLOCK_TYPES,
    createBlock,
    blockToText,
    blockFromText,
    normalizeBlocks,
    normalizeTableRows,
    tableAddRow,
    tableAddColumn,
    tableRemoveRow,
    tableRemoveColumn,
    renderInlineMarkdown,
    markdownToHtml,
    htmlToMarkdown,
    inlineMarkdownToHtml,
} from './ticket.mjs'

const NOTICE_TTL_MS = 4000
const NOTICE_LEAVE_MS = 180
const ROW_EXIT_MS = 160
const HINTS_LEAVE_MS = 150
const REMOTE_ATTRIBUTION_MS = 5000
// How often the Servers pane re-polls paired headless peers while it's open.
const SERVERS_POLL_MS = 20000
// The invite countdown is wall-clock: nothing pushes an event as a code runs
// out, and a code still reading "expires in 0:14" after it died is exactly the
// confusion this change exists to remove. Ticks only while a countdown is on
// screen, so it costs nothing the rest of the time.
const INVITE_TICK_MS = 5000
// How often to re-render the peers pane / devices dialog so presence (online-now,
// "seen ago") decays with wall-clock even when no new heartbeat event arrives.
const PRESENCE_TICK_MS = 20000


// --- WYSIWYG block editor (contentEditable) input rules -------------------
// The markdown + callout blocks edit as live-rendered rich text: the user only
// ever sees compiled markdown, never the raw "**" / "#" syntax. These helpers
// transform a just-completed markdown pattern in place. They are intentionally
// markdown-invariant — htmlToMarkdown('<strong>x</strong>') === htmlToMarkdown('**x**')
// — so the stored markdown is identical whether or not a rule fires, and the
// block always re-renders correctly from markdownToHtml when reopened.
const RICH_SAFE_URL = /^(https?:\/\/|mailto:)/i
const ZWSP = String.fromCharCode(0x200b) // caret anchor, stripped on serialize

function richBlockAncestor (node, root) {
    let n = node
    while (n && n !== root) {
        if (n.nodeType === Node.ELEMENT_NODE && /^(?:p|div|h[1-6])$/i.test(n.tagName)) return n
        n = n.parentNode
    }
    return null
}

// "# " / "## " / "### " at the very start of a paragraph -> heading. Fires the
// instant the trigger space is typed, so the hashes vanish immediately.
function applyHeadingInputRule (root) {
    const sel = window.getSelection()
    if (!sel || !sel.isCollapsed || sel.rangeCount === 0) return false
    const block = richBlockAncestor(sel.anchorNode, root)
    if (!block || /^h[1-6]$/i.test(block.tagName)) return false
    const m = /^(#{1,3}) /.exec(block.textContent)
    if (!m) return false
    const level = m[1].length
    let toRemove = level + 1 // hashes + the single trigger space
    let child = block.firstChild
    while (child && toRemove > 0) {
        if (child.nodeType === Node.TEXT_NODE) {
            const take = Math.min(child.data.length, toRemove)
            child.data = child.data.slice(take)
            toRemove -= take
            if (child.data.length === 0) { const next = child.nextSibling; child.remove(); child = next; continue }
        }
        if (toRemove <= 0) break
        child = child.nextSibling
    }
    const heading = document.createElement('h' + level)
    while (block.firstChild) {
        const c = block.firstChild
        if (c.nodeName === 'BR') { c.remove(); continue } // headings need no <br> filler
        heading.appendChild(c)
    }
    // A caret cannot live inside a truly empty block element in Chromium, so seed
    // a zero-width anchor (stripped on serialize) when the heading is still empty.
    if (!heading.firstChild) heading.appendChild(document.createTextNode(ZWSP))
    block.replaceWith(heading)
    const r = document.createRange()
    r.selectNodeContents(heading)
    r.collapse(false) // caret at the end, *inside* the heading
    sel.removeAllRanges()
    sel.addRange(r)
    return true
}

// `code`, **bold**, *italic*, [label](url) -> styled element when the closing
// marker is typed and a matching opener sits in the same text node before the
// caret. Drops the markers; leaves the caret outside the new (unstyled) element.
// `run` is the capture group holding the exact text to replace ("*italic*"
// excludes the char before the opening "*", so its run is group 1, not 0).
const RICH_INLINE_RULES = [
    { re: /`([^`]+)`$/, tag: 'code', run: 0, content: (m) => m[1] },
    { re: /\*\*([^*]+)\*\*$/, tag: 'strong', run: 0, content: (m) => m[1] },
    { re: /(?:^|[^*])(\*[^*\n]+\*)$/, tag: 'em', run: 1, content: (m) => m[1].slice(1, -1) },
    { re: /\[([^\]]+)\]\(([^)\s]+)\)$/, tag: 'a', run: 0, content: (m) => m[1], url: (m) => m[2] },
]
function applyInlineInputRules () {
    const sel = window.getSelection()
    if (!sel || !sel.isCollapsed || sel.rangeCount === 0) return false
    const node = sel.anchorNode
    if (!node || node.nodeType !== Node.TEXT_NODE) return false
    const offset = sel.anchorOffset
    const before = node.data.slice(0, offset)
    for (const rule of RICH_INLINE_RULES) {
        const m = rule.re.exec(before)
        if (!m) continue
        const start = offset - m[rule.run].length
        if (start < 0) continue
        let el
        if (rule.tag === 'a') {
            const url = rule.url(m)
            if (!RICH_SAFE_URL.test(url)) continue
            el = document.createElement('a')
            el.setAttribute('href', url)
        } else {
            el = document.createElement(rule.tag)
        }
        el.textContent = rule.content(m)
        const range = document.createRange()
        range.setStart(node, start)
        range.setEnd(node, offset)
        range.deleteContents()
        range.insertNode(el)
        // Anchor the caret in a zero-width-space text node *after* the new
        // element so continued typing lands outside it (Chromium otherwise keeps
        // typing inside the just-styled span). The ZWSP is stripped on serialize.
        const tail = document.createTextNode(ZWSP)
        el.after(tail)
        const r2 = document.createRange()
        r2.setStart(tail, 1)
        r2.collapse(true)
        sel.removeAllRanges()
        sel.addRange(r2)
        return true
    }
    return false
}

// Chromium cannot place a caret inside a truly empty block element, so give each
// empty <p>/<h1..3> a zero-width anchor (stripped on serialize). Lets a freshly
// seeded empty heading/paragraph hold the caret after a re-render.
function seedRichCaretAnchors (root) {
    for (const el of root.querySelectorAll('p, h1, h2, h3')) {
        if (!el.firstChild) el.appendChild(document.createTextNode(ZWSP))
    }
}

// Caret position as a count of visible characters (ZWSP anchors excluded) from
// the editor start. Stable across a re-render because the live node and a
// markdown-reseeded node show the same compiled text — so we can restore the
// caret where the user was instead of jumping to the end on a remote update.
function richCaretOffset (root) {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return null
    const range = sel.getRangeAt(0)
    if (!root.contains(range.endContainer)) return null
    const pre = range.cloneRange()
    pre.selectNodeContents(root)
    pre.setEnd(range.endContainer, range.endOffset)
    return pre.toString().split(ZWSP).join("").length
}

function setRichCaretOffset (root, target) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let remaining = target
    let node
    while ((node = walker.nextNode())) {
        const visible = node.data.split(ZWSP).join("").length
        if (remaining <= visible) {
            let raw = 0
            let seen = 0
            while (raw < node.data.length && seen < remaining) {
                if (node.data[raw] !== ZWSP) seen++
                raw++
            }
            const r = document.createRange()
            r.setStart(node, raw)
            r.collapse(true)
            const sel = window.getSelection()
            sel.removeAllRanges()
            sel.addRange(r)
            return true
        }
        remaining -= visible
    }
    return false
}

// Locale-neutral formatters for the Servers monitoring pane. Bytes use binary
// units; durations collapse to the two coarsest non-zero parts.
// formatBytes moved into ./ui/servers.mjs — the storage row on a server card was
// its only caller.
// formatAgo / formatUptime now come from @listam/domain/peer-display — they were
// duplicated byte-for-byte in listam-mobile's app/util/relativeTime.

export function mountApp({ root, store, client, locale, ownerControl = null, appUpdates = null, env = {} }) {
    const ui = {
        // `view` is the surface KIND showing in main: a list surface
        // ('lists' | 'board' | 'todo'), the 'peers' system view, or the
        // cross-list 'overview' (the day plan, which is the default landing).
        // (Servers is a section inside the peers pane; congruency + activity
        // moved into the Settings → Analytics dialog, so they're no longer
        // top-level views.) `activeListId` scopes the list surfaces to one
        // registry list; resolved lazily against the synced registry on first
        // render and whenever the current list disappears.
        view: 'overview',
        // Selected day in the Overview (a 'YYYY-MM-DD' key); '' tracks today.
        planDate: '',
        // Which week the Overview strip shows: 0 = the week starting today, −1 the
        // previous week, +1 the next, etc. Lets the strip page into past days.
        weekOffset: 0,
        // Plan row drag (reorder a tray / insert into a day / drop onto a day pill):
        // { ref, fromDate }.
        planDrag: null,
        activeListId: null,
        // Hex base key of the active list when it lives in its own SHARED base
        // (null = personal base). Routes the list's writes to that base.
        activeBaseKey: null,
        editingListId: null,
        // Inline rename target for a BUILT-IN surface (Groceries/Board/Todo).
        // Keyed by surfaceLabelKey since built-ins share one listId, so
        // editingListId can't distinguish them.
        editingSurfaceKey: null,
        editingGroupId: null,
        dialog: null,
        editingItemId: null,
        focusedItemId: null,
        // List-item Inspector (toggle I): the grocery/todo item whose detail panel
        // is open on the right. Non-modal — the list stays clickable.
        inspectorItemId: null,
        // Notes surface: the note open in the document column, and the index's
        // search box. A note is NOT put in the Inspector — a drawer annotates a
        // row, and a note IS the content — so it takes the column instead.
        activeNoteId: null,
        noteQuery: '',
        // (Per-server monitoring state moved into ./ui/servers.mjs — every
        // reference to it was inside that one block, so it owns it now.)
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
        // Table blocks edit AS a grid, not through the comma-separated blockDraft
        // text channel: blockTableDraft holds the live array-of-arrays and
        // blockTableFocus remembers which cell to (re)focus across re-renders.
        blockTableDraft: null,
        blockTableFocus: null,
        blockStructuredDraft: null,
        blockFieldFocus: null,
        blockMenu: null,
        blockDrag: null,
        boardDrag: null,
        // Rail drag-and-drop: the list surface being dragged between groups.
        // { listId, type, builtin, fromGroupId } while a drag is in flight.
        railDrag: null,
        boardConfigRequested: false,
        // Per-session, in-memory undo history (Ship 1: delete / edit / toggle).
        // Each entry is one gesture's pre-image; undo replays it as a fresh LWW
        // write. Lost on reload and cleared on a base switch (see renderAll).
        undoStack: [],
        // Pear releases are immutable checkpoints for a running process. When
        // the runtime reports a newer release, keep a persistent restart action
        // visible until the user opts into loading it.
        updateReady: false,
        updateRestarting: false,
        updateRestartFailed: false,
        // Last RPC_GET_NET_DIAGNOSTICS snapshot, projected by describeNetDiagnostics.
        // UI-local: it is a point-in-time probe of the transport, not replicated
        // state, and it must not survive a store reset the way sync state does.
        netDiagnostics: null,
        netDiagnosticsBusy: false,
    }
    const now = env.now ?? (() => Date.now())
    // Block ids only need to be unique within a session; the renderer rebuilds
    // the DOM wholesale, so a monotonic counter mixed with the clock suffices.
    let blockIdSeq = 0
    const nextBlockId = () => `b-${now()}-${blockIdSeq++}`
    const draftFor = (block) => blockToText(block)
    // Rigor-task ids follow the same session-unique scheme as block ids so a
    // task added post-creation never collides with a creation-time `task-N-…` id.
    let taskIdSeq = 0
    const nextTaskId = () => `task-${now()}-${taskIdSeq++}`
    // Device-local drawer widths (persisted like theme; never replicated).
    const drawerWidths = {
        insp: Number(localStorage.getItem('listam.inspectorW')) || 0,
        ticket: Number(localStorage.getItem('listam.ticketW')) || 0,
    }
    // Left-edge grip that resizes a right-anchored drawer. Pure style writes
    // during the drag (no re-render); the width persists on release.
    function drawerResizer(el, kind, storeKey, min) {
        const resizer = h('div', { class: 'drawer-resizer', role: 'separator', 'aria-orientation': 'vertical' })
        resizer.addEventListener('pointerdown', (event) => {
            event.preventDefault()
            resizer.setPointerCapture(event.pointerId)
            const move = (ev) => {
                const w = Math.min(Math.max(min, window.innerWidth - ev.clientX), Math.max(min, window.innerWidth - 260))
                drawerWidths[kind] = w
                el.style.width = `${w}px`
            }
            const stop = () => {
                resizer.removeEventListener('pointermove', move)
                try { localStorage.setItem(storeKey, String(Math.round(drawerWidths[kind]))) } catch { /* storage unavailable */ }
            }
            resizer.addEventListener('pointermove', move)
            resizer.addEventListener('pointerup', stop, { once: true })
            resizer.addEventListener('pointercancel', stop, { once: true })
        })
        return resizer
    }
    // First text-bearing block of a body — used to re-seed a folded description
    // for the rigor gate when a ticket moves (see moveItem/foldLegacyText).
    const ticketDescriptionFromBlocks = (blocks) => {
        const hit = (Array.isArray(blocks) ? blocks : []).find((b) => b && typeof b.text === 'string' && b.text.trim())
        return hit ? hit.text.trim() : ''
    }
    // List/group ids double as the registry meta-item's id; clock + counter keeps
    // them unique across a session without coordinating with peers.
    let registryIdSeq = 0
    const nextListId = () => `list-${now()}-${registryIdSeq++}`
    const nextGroupId = () => `group-${now()}-${registryIdSeq++}`
    // Ticket ids are normally minted BY THE BACKEND on add. A draft ticket is
    // written through update-as-create (see buildDraftTicket) so the panel knows
    // the id before the write lands and can keep editing that exact row — which
    // means this side has to mint it. Clock + counter as above, plus a random
    // tail: unlike a list, two devices really can create a ticket in the same
    // millisecond, and a collision here would silently merge two people's work.
    const nextTicketId = () => `ticket-${now()}-${registryIdSeq++}-${Math.random().toString(36).slice(2, 8)}`
    // A note is written through update-as-create for the same reason a draft
    // ticket is: newNote has to know the id to open the document it just made.
    const nextNoteId = () => `note-${now()}-${registryIdSeq++}-${Math.random().toString(36).slice(2, 8)}`
    // The reduced registry derived from the synced meta-items in state.items.
    const currentRegistry = () => reduceRegistry(store.getState().items)

    // Duplicate list names made spoken/name-based targeting ambiguous, so every
    // create/rename validates here. Two name namespaces exist: registry lists
    // (regName) and the built-in surfaces (synced surface labels, listId
    // 'default') — a clash across them is just as ambiguous as within one.
    const foldListName = (value) => String(value ?? '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()
    function listNameTaken(name, { excludeId = null, excludeBuiltinType = null } = {}) {
        const target = foldListName(name)
        if (!target) return false
        const items = store.getState().items
        if (isListNameTaken(items, name, { excludeId })) return true
        const surfaceLabels = reduceSurfaceLabels(items)
        for (const type of [DEFAULT_LIST_TYPE, BOARD_LIST_TYPE, TODO_LIST_TYPE]) {
            if (excludeBuiltinType && canonicalSurfaceType(excludeBuiltinType) === canonicalSurfaceType(type)) continue
            if (foldListName(builtinDisplayName(type, surfaceLabels)) === target) return true
        }
        return false
    }
    const rejectDuplicateListName = () => store.pushNotice(locale.i18n.t('desktop.list.duplicateName'), 'error')

    // Every list must belong to a group; "general" is the mandated default home
    // (also where the former built-in Groceries/Board/Todo surfaces live). Its id
    // is fixed so the registry entry stays addressable across peers and reloads.
    const GENERAL_GROUP_ID = 'general'
    // Ensure a real, synced "general" group meta-item exists so it is renamable
    // and survives reloads. Idempotent (LWW by the fixed id); `pending` only
    // suppresses duplicate sends until the backend echoes the create back, and
    // is cleared once the group is observed — so a deleted general can re-form.
    let generalGroupPending = false
    function ensureGeneralGroup() {
        if (currentRegistry().groups.some((g) => g.id === GENERAL_GROUP_ID)) {
            generalGroupPending = false
            return
        }
        if (generalGroupPending) return
        generalGroupPending = true
        const meta = newGroupMeta({ id: GENERAL_GROUP_ID, name: locale.i18n.t('desktop.group.general'), order: 0 }, now())
        markLocalId(GENERAL_GROUP_ID)
        send(RPC_UPDATE, { item: meta })
    }
    function maybeEnsureGeneralGroup() {
        // Wait for the first full sync so we never blind-create "general" over an
        // existing (possibly renamed) one that just hasn't replicated in yet.
        const state = store.getState()
        if (state.backendReady && state.synced) ensureGeneralGroup()
    }

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

    // --- manual reordering ---------------------------------------------------
    // A reorder is one or more LWW writes of the moved item's `order` field
    // (computeReorder picks midpoints / renormalizes). Every write is marked
    // local so the motion diff doesn't flash it as a remote change.
    function sendReorder(updates) {
        if (!updates.length) return
        const ts = now()
        for (const update of updates) {
            markLocalId(update.id)
            send(RPC_UPDATE, { item: { ...update, updatedAt: ts } })
        }
    }
    // Drop `movedId` next to the row at `targetIndex` (before/after its midpoint)
    // within `group` — the surface's current display-ordered sibling array.
    function reorderItemTo(group, movedId, targetIndex, before) {
        const fromIndex = group.findIndex((entry) => entry && entry.id === movedId)
        if (fromIndex < 0) return
        const insertAt = before ? targetIndex : targetIndex + 1
        const dest = insertAt > fromIndex ? insertAt - 1 : insertAt
        sendReorder(computeReorder(group, fromIndex, dest).updates)
    }
    // Nudge `item` one slot up (delta -1) or down (delta +1) within `group`.
    function reorderItemByStep(group, item, delta) {
        const index = group.findIndex((entry) => entry && entry.id === item.id)
        if (index < 0) return
        sendReorder(computeReorder(group, index, index + delta).updates)
    }
    function dropBefore(event, axis = 'y') {
        const rect = event.currentTarget.getBoundingClientRect()
        return axis === 'x'
            ? (event.clientX - rect.left) < rect.width / 2
            : (event.clientY - rect.top) < rect.height / 2
    }
    // Drag props shared by every reorderable row/card. `group` is the sibling
    // array; reordering is constrained to within that group (a drop whose moved
    // item isn't a member is ignored, so e.g. board cards never reorder across
    // columns this way — that path stays the column status-change drop).
    function reorderDnd(item, group, index, axis = 'y') {
        const inGroup = (drag) => drag && group.some((entry) => entry && entry.id === drag.id)
        return {
            draggable: 'true',
            ondragstart: (event) => {
                ui.itemDrag = { id: item.id }
                event.dataTransfer.effectAllowed = 'move'
                try { event.dataTransfer.setData('text/plain', item.id) } catch { /* some platforms reject */ }
                event.currentTarget.classList.add('dragging')
                event.stopPropagation()
            },
            ondragend: (event) => {
                event.currentTarget.classList.remove('dragging', 'drop-before', 'drop-after')
                ui.itemDrag = null
            },
            ondragover: (event) => {
                const drag = ui.itemDrag
                if (!inGroup(drag) || drag.id === item.id) return
                event.preventDefault()
                event.stopPropagation()
                const before = dropBefore(event, axis)
                event.currentTarget.classList.toggle('drop-before', before)
                event.currentTarget.classList.toggle('drop-after', !before)
            },
            ondragleave: (event) => { event.currentTarget.classList.remove('drop-before', 'drop-after') },
            ondrop: (event) => {
                const drag = ui.itemDrag
                event.currentTarget.classList.remove('drop-before', 'drop-after')
                if (!inGroup(drag)) return
                event.preventDefault()
                event.stopPropagation()
                ui.itemDrag = null
                reorderItemTo(group, drag.id, index, dropBefore(event, axis))
            },
        }
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
    // Mutation replies come back as a JSON string ({ ok, reason } from the
    // backend's replyMutationResult). Tolerates null / non-JSON replies from
    // commands that answer with nothing (or the mock backend).
    function parseReply(raw) {
        if (typeof raw !== 'string' || !raw) return null
        try { return JSON.parse(raw) } catch { return null }
    }
    // A refused write (not writable / sync stalled / unroutable list) used to
    // vanish silently: the backend answers { ok:false } but nothing surfaced
    // it. Say so — the specific cause is on state.writeBlock when the backend
    // messaged it (rendered as a persistent banner), so the toast only covers
    // the caseless refusal.
    function noticeWriteRefused() {
        if (store.getState().writeBlock) return // the write-block banner already explains it
        const text = locale.i18n.t('main.notification.writeRefused')
        if (store.getState().notices.some((notice) => notice.text === text)) return
        store.pushNotice(text, 'error')
    }
    // Resolves with the worker's RAW reply (JSON string or null); the few
    // callers that need it (shareList/joinList) parse it themselves.
    const send = (command, payload) => Promise.resolve(client.send(command, payload)).then((raw) => {
        const res = parseReply(raw)
        if (res?.ok === false && res.reason === 'mutation-refused') noticeWriteRefused()
        else if (res?.ok === true) store.clearWriteBlock()
        return raw
    }).catch((error) => {
        // Never leave a timed-out mutation looking like it succeeded. The
        // persistent banner survives later renders and distinguishes an
        // unresponsive worker from an ordinary validation refusal.
        if (error?.code === 'BACKEND_REQUEST_TIMEOUT') {
            store.setState({ writeBlock: 'backend-unresponsive' })
            return
        }
        store.pushNotice(locale.i18n.t('backend.startFailed'), 'error')
    })

    // --- undo (Ship 1: delete / edit / toggle) -----------------------------
    // A capture is only recorded once its forward write is acknowledged ok, so
    // refused / offline writes never enter the stack (nothing changed → nothing
    // to invert). Undo replays the pre-image as a new LWW write stamped now().
    const UNDO_CAP = 50
    function pushUndo(entry) {
        pushCapped(ui.undoStack, entry, UNDO_CAP)
    }
    // Pair with a send(): records `entry` iff the reply says the write landed.
    function captureIfOk(raw, entry) {
        if (parseReply(raw)?.ok === true) pushUndo(entry)
    }
    function undoLast() {
        const t = locale.i18n.t.bind(locale.i18n)
        const entry = ui.undoStack.at(-1)
        if (!entry) { store.pushNotice(t('main.notification.nothingToUndo'), 'info'); return }
        const lookup = (id) => store.getState().items.find((it) => it.id === id)
        if (!guardOk(entry, lookup)) {
            // The target changed underneath us (a change we can already see);
            // drop the stale entry rather than clobber the newer value.
            ui.undoStack.pop()
            store.pushNotice(t('main.notification.undoConflict'), 'error')
            return
        }
        const { command, payload } = applyInverseWrite(entry, now(), RPC_UPDATE)
        markLocalId(entry.itemId)
        send(command, payload)
        ui.undoStack.pop()
        store.pushNotice(t('main.notification.undone'), 'info')
    }

    // --- this device's advertised name (synced peer-label item) ------------
    // This device only learns its own autobase writer key from the membership
    // roster (the isSelf writer), which arrives after boot. So the peer-label
    // write is deferred: setDeviceName stores the device-local copy immediately
    // and maybeAssertDeviceName (run each render) writes/updates the synced label
    // once the key is known and the synced value differs. `assertedPeerLabel`
    // guards against re-sending the same (key,name) on every render.
    let assertedPeerLabel = ''
    function selfWriterKey() {
        return store.getState().roster?.writers?.find((w) => w.isSelf)?.writerKey ?? null
    }
    function assertDeviceName(name) {
        const key = selfWriterKey()
        if (!key) return
        const signature = `${key}\0${name}`
        if (assertedPeerLabel === signature) return
        assertedPeerLabel = signature
        const synced = reducePeerLabels(store.getState().items).get(key) ?? ''
        if (synced === name) return
        const item = buildPeerLabelItem({ writerKey: key, name, updatedAt: now() })
        markLocalId(item.id)
        send(RPC_UPDATE, { item })
    }
    function maybeAssertDeviceName() {
        const name = store.getState().preferences.deviceName
        if (name) assertDeviceName(name)
    }
    // A friendly default so devices aren't nameless (peers otherwise fall back to
    // raw hex). Derived from the platform; the user can rename in Settings.
    function defaultDeviceName() {
        try {
            const nav = globalThis.navigator
            const p = (nav && (nav.userAgentData?.platform || nav.platform || nav.userAgent)) || ''
            if (/mac|darwin|iphone|ipad/i.test(p)) return 'Mac'
            if (/win/i.test(p)) return 'Windows PC'
            if (/linux|x11|cros/i.test(p)) return 'Linux'
        } catch { /* no navigator (headless) */ }
        return 'My device'
    }
    // Seed the default ONCE (guarded by deviceNameSeeded so a user who clears the
    // name is never re-seeded). Run at boot, before subscribe, so it doesn't
    // re-enter render.
    function maybeSeedDeviceName() {
        const prefs = store.getState().preferences
        if (prefs.deviceName || prefs.deviceNameSeeded) return
        store.setPreferences({ deviceName: defaultDeviceName(), deviceNameSeeded: true })
    }

    // Built-in group placement used to live only in device-local localStorage
    // (preferences.builtinGroups), so a freshly joined device never saw it. Once,
    // republish any such placement to the synced BUILTIN-GROUP channel so it
    // reaches other devices. Deferred until the base is writable (a self writer
    // key exists, like the peer label), guarded by a session flag + the persisted
    // `builtinGroupsMigrated`, and skips any key already present synced (so a
    // newer assignment from another device always wins via LWW).
    let builtinGroupsMigrated = false
    function migrateBuiltinGroups() {
        if (builtinGroupsMigrated) return
        if (store.getState().preferences.builtinGroupsMigrated) { builtinGroupsMigrated = true; return }
        if (!selfWriterKey()) return
        const local = store.getState().preferences.builtinGroups
        const localMap = local && typeof local === 'object' ? local : {}
        const synced = reduceBuiltinGroups(store.getState().items)
        for (const [key, groupId] of Object.entries(localMap)) {
            if (!groupId || synced.has(key)) continue
            const idx = key.indexOf(':')
            if (idx <= 0) continue
            const listId = key.slice(0, idx)
            const type = key.slice(idx + 1)
            if (!type) continue
            const item = buildBuiltinGroupItem({ listId, type, groupId, updatedAt: now() })
            markLocalId(item.id)
            send(RPC_UPDATE, { item })
        }
        builtinGroupsMigrated = true
        store.setPreferences({ builtinGroupsMigrated: true })
    }

    // --- encrypted backup / restore ---------------------------------------
    // Lives in ./ui/backup.mjs. It takes the shared `ui` rather than owning its
    // state: the backup dialogs read ui.backups/backupPasswordSet/backupSchedule,
    // and the join flow writes backupPasswordSet before replacing the base.
    // renderAll/openDialog/closeDialog are function declarations, so they are
    // already bound here even though they appear later in this file.
    const {
        backupRequest,
        startBackupImport,
        runBackupExport,
        runBackupImport,
        loadAutoBackups,
        runSetBackupSchedule,
        runSetBackupPassword,
        runRestoreAutoBackup,
    } = createBackupOps({ client, ui, store, locale, renderAll, openDialog, closeDialog })

    // --- flatten history (owner only) --------------------------------------
    // Lives in ./ui/compaction.mjs. Same shared-`ui` argument as backup: the
    // readiness reply is read by the settings dialog and refreshed when it opens.
    const {
        refreshCompactionReadiness,
        runCompaction,
        renderCompactionSection,
    } = createCompactionOps({ client, ui, store, locale, renderAll, closeDialog })

    // Flattening is irreversible and affects every device on the project, so it
    // goes through a confirm step like the other destructive actions rather than
    // firing on the first click.
    function confirmCompaction() {
        openDialog({ kind: 'compaction-confirm' })
    }

    // Persist the lifecycle of a built-in surface through the same replicated
    // label channel as its name and group. The domain reducer lets matching
    // content at the same/newer timestamp resurrect a hidden surface, which is
    // essential for untargeted voice/quick adds to the default grocery bucket.
    function setBuiltinVisibility(listId, type, hidden, updatedAt = now()) {
        const item = buildBuiltinVisibilityItem({ listId, type, hidden, updatedAt })
        markLocalId(item.id)
        return send(RPC_UPDATE, { item })
    }

    const actions = {
        // The add-bar entry point. On a value-return todo surface, ratings are
        // mandatory, so defer to a small rating dialog that collects value+delay
        // and then calls addItem with them; otherwise add straight away.
        addItemGated(text) {
            const trimmed = text.trim()
            if (!trimmed) return false
            if (ui.view === 'todo' && isValueSurface(ui.activeListId, ui.activeType)) {
                openDialog({ kind: 'value-rate', mode: 'todo-add', text: trimmed, valueRate: null, delayRate: null })
                return true // consumed; the dialog finishes the add
            }
            return actions.addItem(trimmed)
        },
        addItem(text, extra = null) {
            const trimmed = text.trim()
            if (!trimmed) return false
            // The add bar serves whichever simple-list surface is showing, filed
            // on the ACTIVE list. A to-do add carries the to-do type; dedupe is
            // scoped to that same list + surface.
            const isTodo = ui.view === 'todo'
            const onSurface = isTodo ? isTodoItem : isGroceryItem
            const listId = ui.activeListId
            const duplicate = store.getState().items.find(
                (item) => item.listId === listId && onSurface(item) && !item.isDone && item.text.trim().toLowerCase() === trimmed.toLowerCase(),
            )
            if (duplicate) {
                store.pushNotice(locale.i18n.t('main.notification.duplicateAdd', { text: trimmed }), 'info')
                return false
            }
            markLocalText(trimmed)
            // Carry the value/delay rates when present (value-return surfaces).
            const rates = hasValueRating(extra) ? { valueRate: clampRate(extra.valueRate), delayRate: clampRate(extra.delayRate) } : {}
            // A shared list's writes carry its baseKey so the backend routes them
            // to that base (UPDATE/DELETE/MOVE already carry it on the item).
            send(RPC_ADD, { text: trimmed, listId, listType: isTodo ? TODO_LIST_TYPE : undefined, baseKey: ui.activeBaseKey || undefined, ...rates })
                .then((raw) => {
                    // The bar cleared optimistically; a refused add (surfaced by
                    // `send`) would still lose the typed text. Put it back into a
                    // still-open, still-idle add bar — never over a newer draft.
                    if (parseReply(raw)?.ok !== false) return
                    const live = root.querySelector('#add-item-input')
                    if (!live || live.value.trim()) return
                    live.value = trimmed
                    live.classList.remove('shake')
                    void live.offsetWidth
                    live.classList.add('shake')
                })
            return true
        },
        // --- list registry (groups, lists) --------------------------------
        // Each mutation re-emits a FULL meta-item via RPC_UPDATE (never RPC_ADD,
        // which would regenerate the id — a meta-item's id IS the list/group id).
        // The builders rebuild from the current reduced entry, so a partial edit
        // never clobbers sibling reg* fields.
        createList({ name, type, groupId = GENERAL_GROUP_ID }) {
            // Every list must have a group; default to "general" and make sure
            // that group's meta-item exists before filing the list under it.
            if (listNameTaken(name)) { rejectDuplicateListName(); return null }
            const dest = groupId || GENERAL_GROUP_ID
            if (dest === GENERAL_GROUP_ID) ensureGeneralGroup()
            const id = nextListId()
            const meta = newListMeta({ id, name: (name ?? '').trim(), type, groupId: dest, order: nextListOrder(currentRegistry(), dest) }, now())
            markLocalId(id)
            send(RPC_UPDATE, { item: meta })
            return id
        },
        createGroup({ name }) {
            const id = nextGroupId()
            const meta = newGroupMeta({ id, name: (name ?? '').trim(), order: nextGroupOrder(currentRegistry()) }, now())
            markLocalId(id)
            send(RPC_UPDATE, { item: meta })
            return id
        },
        renameList(id, name) {
            if (listNameTaken(name, { excludeId: id })) { rejectDuplicateListName(); return }
            const meta = patchListMeta(currentRegistry(), id, { name: (name ?? '').trim() }, now())
            if (!meta) return
            markLocalId(id)
            send(RPC_UPDATE, { item: meta })
        },
        renameGroup(id, name) {
            const meta = patchGroupMeta(currentRegistry(), id, { name: (name ?? '').trim() }, now())
            if (!meta) return
            markLocalId(id)
            send(RPC_UPDATE, { item: meta })
        },
        moveListToGroup(id, groupId) {
            // A list always lands in a real group; an empty/missing target falls
            // back to "general" (ensuring it exists).
            const dest = groupId || GENERAL_GROUP_ID
            if (dest === GENERAL_GROUP_ID) ensureGeneralGroup()
            const registry = currentRegistry()
            const meta = patchListMeta(registry, id, { groupId: dest, order: nextListOrder(registry, dest) }, now())
            if (!meta) return
            markLocalId(id)
            send(RPC_UPDATE, { item: meta })
        },
        reorderList(id, order) {
            const meta = patchListMeta(currentRegistry(), id, { order }, now())
            if (!meta) return
            markLocalId(id)
            send(RPC_UPDATE, { item: meta })
        },
        deleteList(id) {
            const meta = deleteListMeta(currentRegistry(), id, now())
            if (!meta) return
            markLocalId(id)
            send(RPC_UPDATE, { item: meta })
            // Cascade: drop the list's items too, otherwise they'd resurface as
            // an unnamed stray list (detectExtraLists picks up any listId that
            // has items but no meta-item).
            for (const item of store.getState().items.filter((i) => i.listId === id)) {
                send(RPC_DELETE, { item })
            }
        },
        deleteGroup(id) {
            // "general" is the mandated default home and can't be deleted (the UI
            // hides its delete control too).
            if (id === GENERAL_GROUP_ID) return
            const registry = currentRegistry()
            const meta = deleteGroupMeta(registry, id, now())
            if (!meta) return
            markLocalId(id)
            send(RPC_UPDATE, { item: meta })
            // A list must always have a group: re-home this group's lists into
            // "general" rather than leaving them orphaned.
            const orphans = registry.lists.filter((l) => l.groupId === id)
            if (orphans.length) ensureGeneralGroup()
            for (const list of orphans) {
                const moved = patchListMeta(registry, list.id, { groupId: GENERAL_GROUP_ID, order: nextListOrder(registry, GENERAL_GROUP_ID) }, now())
                if (!moved) continue
                markLocalId(list.id)
                send(RPC_UPDATE, { item: moved })
            }
        },
        // Synced rename of a former built-in surface (Groceries/Board/Todo). They
        // share listId 'default' and so have no registry meta-item; this writes a
        // surface-name label item keyed by (listId:type). Empty name clears the
        // override (reverts to the localized default).
        renameBuiltin(listId, type, name) {
            if ((name ?? '').trim() && listNameTaken(name, { excludeBuiltinType: type })) { rejectDuplicateListName(); return }
            const item = buildSurfaceLabelItem({ listId, type, name: (name ?? '').trim(), updatedAt: now() })
            markLocalId(item.id)
            send(RPC_UPDATE, { item })
        },
        // Delete a former built-in surface. With no registry meta-item to
        // tombstone, deletion cascades only its items on (default,type). Grocery
        // visibility is synced; Board/Todo retain their legacy device-local hide.
        deleteBuiltin(listId, type) {
            const pred = typePredicate(type)
            const surfaceItems = store.getState().items.filter((i) => i.listId === listId && pred(i))
            for (const item of surfaceItems) {
                send(RPC_DELETE, { item })
            }
            if (!isBoardType(type) && !isTodoType(type)) {
                const newestItemWrite = surfaceItems.reduce(
                    (max, item) => Math.max(max, Number(item?.updatedAt) || 0),
                    0,
                )
                setBuiltinVisibility(listId, type, true, Math.max(now(), newestItemWrite + 1))
            } else {
                const key = surfaceLabelKey(listId, type)
                const hidden = Array.isArray(store.getState().preferences.hiddenBuiltins) ? store.getState().preferences.hiddenBuiltins : []
                if (!hidden.includes(key)) store.setPreferences({ hiddenBuiltins: [...hidden, key] })
            }
            if (ui.activeListId === listId && surfaceForType(ui.activeType) === surfaceForType(type)) {
                ui.activeListId = null
                ui.activeType = null
                ui.view = 'lists'
            }
        },
        // Drag-assign a built-in to a group. Writes the device-local cache AND a
        // synced BUILTIN-GROUP item so other devices file the surface into the
        // same group. 'general' is stored as absence locally and as an empty
        // (cleared) synced value, so a move back to general propagates too.
        setBuiltinGroup(listId, type, groupId) {
            const dest = groupId || GENERAL_GROUP_ID
            const key = surfaceLabelKey(listId, type)
            const cur = store.getState().preferences.builtinGroups
            const next = { ...(cur && typeof cur === 'object' ? cur : {}) }
            if (dest === GENERAL_GROUP_ID) delete next[key]
            else next[key] = dest
            store.setPreferences({ builtinGroups: next })
            const item = buildBuiltinGroupItem({ listId, type, groupId: dest === GENERAL_GROUP_ID ? '' : dest, updatedAt: now() })
            markLocalId(item.id)
            send(RPC_UPDATE, { item })
        },
        // Collapse/expand a rail group (device-local). Stored as presence so the
        // map only carries collapsed groups; absence means expanded.
        toggleGroupCollapsed(groupId) {
            if (!groupId) return
            const cur = store.getState().preferences.collapsedGroups
            const next = { ...(cur && typeof cur === 'object' ? cur : {}) }
            if (next[groupId]) delete next[groupId]
            else next[groupId] = true
            store.setPreferences({ collapsedGroups: next })
        },
        // Advertise this device's name to peers. Stores the device-local copy and
        // writes the synced peer-label item once this device's writer key is known
        // (maybeAssertDeviceName re-tries on roster arrival if it wasn't yet).
        setDeviceName(name) {
            const clean = (name ?? '').trim()
            store.setPreferences({ deviceName: clean })
            assertDeviceName(clean)
        },
        // --- day plan (Overview) ------------------------------------------
        // Plan entries are synced meta-items: a pointer to a source item (or a
        // whole list) plus a day key. Every write upserts via RPC_UPDATE keyed
        // on the deterministic plan ref, exactly like the registry/label
        // meta-items — never RPC_ADD (which would regenerate the id).
        flagItemForDay(item, dateKey) {
            if (!item) return
            const entry = buildItemPlanEntry({ listId: item.listId, itemId: item.id, plannedFor: dateKey, planOrder: now(), updatedAt: now() })
            markLocalId(entry.id)
            send(RPC_UPDATE, { item: entry })
        },
        flagListForDay(listId, listType, dateKey) {
            const entry = buildListPlanEntry({ listId, listType, plannedFor: dateKey, planOrder: now(), updatedAt: now() })
            markLocalId(entry.id)
            send(RPC_UPDATE, { item: entry })
        },
        // One-click row star: toggle an item in/out of today's plan.
        toggleItemPlan(item) {
            if (!item) return
            const ref = planItemKey(item.listId, item.id)
            if (reducePlan(store.getState().items).has(ref)) actions.clearFromPlan(ref)
            else actions.flagItemForDay(item, toDateKey(now()))
        },
        toggleListPlan(listId, listType) {
            const ref = planListKey(listId, listType)
            if (reducePlan(store.getState().items).has(ref)) actions.clearFromPlan(ref)
            else actions.flagListForDay(listId, listType, toDateKey(now()))
        },
        isItemPlanned(item) {
            return !!item && reducePlan(store.getState().items).has(planItemKey(item.listId, item.id))
        },
        // Move a plan entry to another day (drop onto a day pill, or future-day pick).
        movePlanToDay(ref, dateKey) {
            const rec = reducePlan(store.getState().items).get(ref)
            if (!rec || rec.plannedFor === dateKey) return
            const entry = buildPlanItem({ id: ref, kind: rec.kind, refListId: rec.refListId, refItemId: rec.refItemId, refType: rec.refType, plannedFor: dateKey, planOrder: now(), updatedAt: now() })
            markLocalId(ref)
            send(RPC_UPDATE, { item: entry })
        },
        // Move a plan entry from another day into an exact position in a day's
        // agenda. Usually only the moved record is written; a destination with
        // exhausted order gaps may also be renormalized by computePlanInsert.
        movePlanIntoDay(ref, dateKey, dayRecords, toIndex) {
            const rec = reducePlan(store.getState().items).get(ref)
            if (!rec) return
            const records = (Array.isArray(dayRecords) ? dayRecords : []).filter((r) => r?.ref !== ref)
            const { updates } = computePlanInsert(records, rec, toIndex)
            if (!updates.length) return
            const ts = now()
            for (const u of updates) {
                const source = u.ref === ref ? rec : records.find((r) => r.ref === u.ref)
                if (!source) continue
                const entry = buildPlanItem({
                    id: source.ref,
                    kind: source.kind,
                    refListId: source.refListId,
                    refItemId: source.refItemId,
                    refType: source.refType,
                    plannedFor: source.ref === ref ? dateKey : source.plannedFor,
                    planOrder: u.planOrder,
                    updatedAt: ts,
                })
                markLocalId(source.ref)
                send(RPC_UPDATE, { item: entry })
            }
        },
        // Remove a plan entry (unflag an item / clear a list-card). An empty
        // plannedFor is the conflict-free clear (reducePlan drops it).
        clearFromPlan(ref) {
            const rec = reducePlan(store.getState().items).get(ref)
            if (!rec) return
            const entry = buildPlanItem({ id: ref, kind: rec.kind, refListId: rec.refListId, refItemId: rec.refItemId, refType: rec.refType, plannedFor: '', planOrder: rec.planOrder, updatedAt: now() })
            markLocalId(ref)
            send(RPC_UPDATE, { item: entry })
        },
        reorderPlanRecords(orderedRecords, fromIndex, toIndex) {
            const { updates } = computePlanReorder(orderedRecords, fromIndex, toIndex)
            if (!updates.length) return
            const ts = now()
            for (const u of updates) {
                const rec = orderedRecords.find((r) => r.ref === u.ref)
                if (!rec) continue
                const entry = buildPlanItem({ id: rec.ref, kind: rec.kind, refListId: rec.refListId, refItemId: rec.refItemId, refType: rec.refType, plannedFor: rec.plannedFor, planOrder: u.planOrder, updatedAt: ts })
                markLocalId(rec.ref)
                send(RPC_UPDATE, { item: entry })
            }
        },
        setOverviewView(view) {
            const allowed = view === 'planner' || view === 'value' ? view : 'focus'
            store.setPreferences({ overviewView: allowed })
        },
        // Toggle the value-return property for a surface (synced per-surface flag,
        // keyed by the canonical type so built-in + named lists behave the same).
        setValueReturn(listId, type, enabled) {
            const item = buildValueReturnItem({ listId, type: canonicalSurfaceType(type), enabled: !!enabled, updatedAt: now() })
            markLocalId(item.id)
            send(RPC_UPDATE, { item })
        },
        toggleItem(item) {
            markLocalId(item.id)
            const ts = now()
            const forward = { ...item, isDone: !item.isDone, timeOfCompletion: item.isDone ? 0 : ts, updatedAt: ts }
            const entry = buildUndoEntry({ kind: 'toggle', itemId: item.id, preImage: item, touched: { isDone: forward.isDone, timeOfCompletion: forward.timeOfCompletion } })
            send(RPC_UPDATE, { item: forward }).then((raw) => captureIfOk(raw, entry))
        },
        editItem(item, text) {
            const trimmed = text.trim()
            if (!trimmed || trimmed === item.text) return
            markLocalId(item.id)
            const entry = buildUndoEntry({ kind: 'edit', itemId: item.id, preImage: item, touched: { text: trimmed } })
            send(RPC_UPDATE, { item: { ...item, text: trimmed, updatedAt: now() } }).then((raw) => captureIfOk(raw, entry))
        },
        deleteItem(item) {
            markLocalId(item.id)
            // Undo resurrects by re-writing the full pre-image under its original
            // id (order preserved → position restored); pushed only once the
            // delete lands ok, inside the row-exit callback.
            const entry = buildUndoEntry({ kind: 'delete', itemId: item.id, preImage: item })
            animateRowExit(item, () => send(RPC_DELETE, { item }).then((raw) => captureIfOk(raw, entry)))
        },
        // Move an item to a different list and/or type, WITHIN this project. The
        // backend decomposes it into add+delete (different listId) or a single
        // in-place type flip (same listId). Promoting an item into a rigor board
        // first collects the required ticket fields via the create form, so the
        // backend's rigor gate never silently drops it.
        moveItem(item, targetListId, targetType) {
            if (!item) return
            if (item.listId === targetListId && surfaceForType(item.listType) === surfaceForType(targetType)) return
            let payload = item
            if (isBoardType(targetType)) {
                // The description may have been folded into the block body
                // (foldLegacyText). Every peer's rigor gate still checks the
                // plain description string — making the shared gate blocks-
                // aware would diverge apply() across builds (the board-rename
                // lesson) — so re-seed it write-side from the first text-
                // bearing block; the fold's duplicate guard clears it again on
                // the next open without doubling content.
                const description = (typeof item.description === 'string' && item.description.trim())
                    ? item.description
                    : ticketDescriptionFromBlocks(item.blocks)
                if (description !== (item.description || '')) payload = { ...item, description }
                const config = selectBoardConfig(listAccess(store.getState(), targetListId))
                const candidate = { text: item.text, description, checklist: item.checklist, estimatedHours: item.estimatedHours, estimatedComplexity: item.estimatedComplexity }
                if (config.rigorOn && validateRigorDraft(candidate, config).missing.length > 0) {
                    const tasks = (Array.isArray(item.checklist) && item.checklist.length) ? item.checklist.map((task) => task.text) : ['']
                    openDialog({
                        kind: 'add-ticket',
                        moveFrom: item,
                        targetListId,
                        draft: {
                            description: description || item.text || '',
                            tasks,
                            hours: item.estimatedHours ? String(item.estimatedHours) : '',
                            complexity: Number.isFinite(item.estimatedComplexity) ? item.estimatedComplexity : 50,
                        },
                    })
                    return
                }
            }
            markLocalId(item.id)
            send(RPC_MOVE, { item: payload, targetListId, targetListType: isBoardType(targetType) ? BOARD_WRITE_TYPE : targetType })
        },
        clearDone() {
            const onSurface = ui.view === 'todo' ? isTodoItem : isGroceryItem
            selectDoneItems(store.getState().items.filter(onSurface)).forEach((item, index) => {
                markLocalId(item.id)
                animateRowExit(item, () => send(RPC_DELETE, { item }), index * 40)
            })
        },
        // --- board --------------------------------------------------------
        // Opening the panel MATERIALIZES the ticket (see the draft-autosave
        // block): the row exists before the dialog is built, and every field
        // edits it in place. It stays marked `draft: true` — amber on the board,
        // pinned in its column — until the panel commits it.
        newTicket() {
            const draft = emptyTicketDraft()
            const listId = ui.activeListId
            const valueOn = isValueSurface(listId, ui.activeType)
            const id = nextTicketId()
            const item = buildDraftTicket({
                id,
                listId,
                listType: BOARD_WRITE_TYPE,
                // Only addItem stamps this backend-side, and this row is written
                // through update; without it computeCongruency cannot attribute
                // the ticket to whoever wrote it.
                createdBy: selfWriterKey(),
                fields: { estimatedComplexity: draft.complexity },
                now: now(),
            })
            if (!item) return
            markLocalId(id)
            send(RPC_UPDATE, { item })
            openTicketDraftDialog(id, draft, valueOn)
        },
        // Resume an unfinished draft: the same panel, seeded from the live row
        // rather than from blank. This is what a click on an amber card does.
        editTicketDraft(item) {
            if (!isDraftTicket(item)) return
            openTicketDraftDialog(item.id, ticketDraftFromItem(item), isValueSurface(item.listId, item.listType))
        },
        // The backend freezes time-in-progress + the on-time verdict from this
        // status change; the frontend only sends the new status with a bumped
        // updatedAt (so the LWW reducer never drops it).
        moveTicket(item, status) {
            // An unfinished draft is pinned where it is: the rigor gate no
            // longer blocks the ticket's CREATION (the panel materializes it on
            // open), so it blocks its first move instead. With rigor off there
            // is nothing to satisfy and nothing is pinned.
            const gate = canMoveTicket(item, selectBoardConfig(listAccess(store.getState(), item.listId)))
            if (!gate.ok) {
                store.pushNotice(locale.i18n.t('ticket.draft.pinned'), 'error')
                return
            }
            const payload = buildStatusChange(item, status, now())
            if (!payload) return
            // Dropping into a different column clears the manual order so the
            // ticket lands at the top (unordered) of its new column; within-
            // column drops keep their order via reorderItemTo instead.
            delete payload.order
            markLocalId(item.id)
            send(RPC_UPDATE, { item: payload })
        },
        toggleTicketTask(item, taskId) {
            const checklist = (Array.isArray(item.checklist) ? item.checklist : [])
                .map((task) => (task.id === taskId ? { ...task, done: !task.done } : task))
            markLocalId(item.id)
            send(RPC_UPDATE, { item: { ...item, checklist, updatedAt: now() } })
        },
        // Append a task to the rigor checklist after the ticket already exists
        // (creation seeds it; this lets the checklist grow as work is scoped).
        addTicketTask(item, text) {
            const nv = (text || '').trim()
            if (!nv) return false
            const existing = Array.isArray(item.checklist) ? item.checklist : []
            const checklist = [...existing, { id: nextTaskId(), text: nv, done: false }]
            markLocalId(item.id)
            send(RPC_UPDATE, { item: { ...item, checklist, updatedAt: now() } })
            return true
        },
        removeTicketTask(item, taskId) {
            const checklist = (Array.isArray(item.checklist) ? item.checklist : [])
                .filter((task) => task.id !== taskId)
            markLocalId(item.id)
            send(RPC_UPDATE, { item: { ...item, checklist, updatedAt: now() } })
        },
        // Card click -> right drawer that slides in over the right half of the
        // screen (the board stays full-width and visible underneath).
        openTicket(id) {
            // An amber draft has no detail drawer yet — it reopens the panel it
            // was left in, so the click means "carry on where I stopped".
            const target = store.getState().items.find((entry) => entry && entry.id === id)
            if (isDraftTicket(target)) { actions.editTicketDraft(target); return }
            const changed = ui.selectedTicketId !== id
            ui.selectedTicketId = id
            ui.ticketDocId = null
            ui.blockEditingId = null
            ui.blockMenu = null
            ui.view = 'board'
            // Fold only on a genuine open (not a re-click of the already-open
            // card) so a second click before the fold echo returns can't re-read
            // the still-set description and fold it twice.
            const item = changed ? store.getState().items.find((entry) => entry && entry.id === id) : null
            if (item) actions.foldLegacyText(item, 'description')
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
            seedBlockDraft(null)
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
        // Generic LWW field patch for a list item (quantity from the
        // Inspector). The reducer spreads ...item so new optional fields round-trip.
        setItemFields(item, patch) {
            markLocalId(item.id)
            send(RPC_UPDATE, { item: { ...item, ...patch, updatedAt: now() } })
        },
        openInspector(id) {
            const changed = ui.inspectorItemId !== id
            if (changed) {
                // Switching items: the previous block editor's blur has already
                // committed; just drop the stale edit/menu state.
                ui.blockEditingId = null
                ui.blockDraft = ''
                seedBlockDraft(null)
                ui.blockMenu = null
            }
            ui.inspectorItemId = id
            // Fold only on a genuine open (see openTicket) so a re-click before
            // the fold echo returns can't fold the same note twice.
            const item = changed ? store.getState().items.find((entry) => entry && entry.id === id) : null
            if (item) actions.foldLegacyText(item, 'note')
            renderAll()
        },
        closeInspector() {
            ui.inspectorItemId = null
            ui.blockEditingId = null
            ui.blockDraft = ''
            seedBlockDraft(null)
            ui.blockMenu = null
            renderAll()
        },
        toggleInspector(id) {
            if (ui.inspectorItemId === id) actions.closeInspector()
            else actions.openInspector(id)
        },
        // --- notes ---------------------------------------------------------
        // A note is created empty and opened straight away with its title
        // focused: the title IS the first thing typed, and blocks come later (or
        // never). Written through update-as-create like a draft ticket, because
        // RPC_ADD mints the id backend-side and this has to know it NOW to open
        // the document it just made.
        newNote() {
            const listId = ui.activeListId
            if (listId == null) return
            const id = nextNoteId()
            markLocalId(id)
            send(RPC_UPDATE, {
                item: {
                    id,
                    listId,
                    listType: NOTES_LIST_TYPE,
                    text: '',
                    isDone: false,
                    timeOfCompletion: 0,
                    updatedAt: now(),
                    // A shared list's writes carry its baseKey so the backend
                    // routes them to that base (see addItem).
                    ...(ui.activeBaseKey ? { baseKey: ui.activeBaseKey } : {}),
                },
            })
            ui.activeNoteId = id
            ui.blockEditingId = null
            ui.blockDraft = ''
            seedBlockDraft(null)
            ui.blockMenu = null
            renderAll()
            // editableText restores focus across a re-render, not on first entry
            // into a field that did not exist a render ago.
            queueMicrotask(() => root.querySelector('#note-title')?.focus())
        },
        openNote(id) {
            const changed = ui.activeNoteId !== id
            if (changed) {
                // Switching notes: the previous block editor's blur has already
                // committed; just drop the stale edit/menu state.
                ui.blockEditingId = null
                ui.blockDraft = ''
                seedBlockDraft(null)
                ui.blockMenu = null
            }
            ui.activeNoteId = id
            ui.focusedItemId = id
            // Fold only on a genuine open (see openInspector) so a re-click before
            // the fold echo returns can't fold the same note twice.
            const item = changed ? store.getState().items.find((entry) => entry && entry.id === id) : null
            if (item) actions.foldLegacyText(item, 'note')
            renderAll()
        },
        // Open a plan-row item from the Overview: navigate to its source surface
        // and, for a board ticket, open its detail drawer.
        openPlanItem(item) {
            if (!item) return
            selectSurface(store.getState(), { listId: item.listId, type: canonicalSurfaceType(item.listType) })
            if (isBoardType(item.listType)) {
                const changed = ui.selectedTicketId !== item.id
                ui.selectedTicketId = item.id
                ui.ticketDocId = null
                if (changed) actions.foldLegacyText(item, 'description')
            }
            renderAll()
        },
        // --- block-based body --------------------------------------------
        // Fold legacy free-text (item `note`, ticket `description`) into a
        // leading markdown block when a detail surface opens. Continuous
        // dual-read: text an older build or another platform writes into the
        // legacy field surfaces as a block on the next open here, and the
        // field is cleared in the same LWW write so it never folds twice.
        foldLegacyText(item, field) {
            const text = typeof item[field] === 'string' ? item[field].trim() : ''
            if (!text) return
            // Keep the raw blocks array (not normalizeBlocks): merely opening
            // an item must never strip block types a newer peer wrote that
            // this build doesn't know yet.
            const blocks = (Array.isArray(item.blocks) ? item.blocks : []).filter((b) => b && typeof b === 'object')
            // Idempotence: when the text already sits in a block verbatim
            // (e.g. moveItem re-seeded the description from the body for the
            // rigor gate), just clear the field instead of doubling content.
            const dup = blocks.some((b) => typeof b.text === 'string' && b.text.trim() === text)
            const next = dup ? blocks : [{ ...createBlock('markdown', nextBlockId()), ...blockFromText('markdown', text) }, ...blocks]
            markLocalId(item.id)
            send(RPC_UPDATE, { item: { ...item, [field]: '', blocks: next, updatedAt: now() } })
        },
        commitBlocks(item, blocks) {
            if (JSON.stringify(blocksFor(item)) === JSON.stringify(blocks)) {
                renderAll()
                return
            }
            // Keep the most recent body visible until its write is projected.
            // Serialize writes per item so clearing the next block immediately
            // cannot rebuild the body from an older backend snapshot.
            const previous = pendingBlockWrites.get(item.id)
            const pending = { blocks: JSON.parse(JSON.stringify(blocks)), acknowledged: false, generation: blockWriteGeneration }
            pendingBlockWrites.set(item.id, pending)
            pending.promise = Promise.resolve(previous?.promise).then(() => {
                if (pending.generation !== blockWriteGeneration) return
                const latest = store.getState().items.find((entry) => entry.id === item.id) || item
                pending.updatedAt = Math.max(now(), (previous?.updatedAt || 0) + 1)
                markLocalId(item.id)
                return send(RPC_UPDATE, { item: { ...latest, blocks: pending.blocks, updatedAt: pending.updatedAt } })
            }).then((raw) => {
                if (pendingBlockWrites.get(item.id) !== pending) return
                if (parseReply(raw)?.ok === true) pending.acknowledged = true
                else pendingBlockWrites.delete(item.id)
                renderAll()
            })
        },
        startBlockEdit(item, block, focus = null) {
            // Switching blocks: flush the block being edited first so its draft
            // is never lost.
            if (ui.blockEditingId && ui.blockEditingId !== block.id) {
                actions.commitBlocks(item, blocksWithPendingEdit(item))
            }
            ui.blockEditingId = block.id
            ui.blockDraft = draftFor(block)
            ui.blockCaret = null
            seedBlockDraft(block)
            ui.blockFieldFocus = focus
            ui.blockMenu = null
            renderAll()
        },
        commitBlockEdit(item) {
            if (!ui.blockEditingId) return
            const blocks = blocksWithPendingEdit(item)
            const edited = blocks.find((b) => b.id === ui.blockEditingId)
            if (edited && isEmptyBlock(edited)) { actions.deleteBlock(item, edited.id); return }
            ui.blockEditingId = null
            ui.blockDraft = ''
            seedBlockDraft(null)
            ui.blockMenu = null
            actions.commitBlocks(item, blocks)
            renderAll()
        },
        cancelBlockEdit() {
            ui.blockEditingId = null
            ui.blockDraft = ''
            seedBlockDraft(null)
            ui.blockMenu = null
            renderAll()
        },
        // `seed` is text the new block starts with — what the writer had
        // already typed past a shorthand, or into the trailing composer.
        insertBlock(item, type, afterId = null, seed = '') {
            const fresh = createBlock(type, nextBlockId())
            const block = seed ? { ...fresh, ...blockFromText(type, seed) } : fresh
            const blocks = blocksFor(item)
            let next
            if (afterId == null) {
                next = [...blocks, block]
            } else {
                const idx = blocks.findIndex((b) => b.id === afterId)
                next = idx < 0 ? [...blocks, block] : [...blocks.slice(0, idx + 1), block, ...blocks.slice(idx + 1)]
            }
            ui.blockMenu = null
            // A divider has nothing to edit, so it lands placed (not in edit mode).
            if (type === 'divider') { ui.blockEditingId = null; ui.blockDraft = '' } else {
                ui.blockEditingId = block.id
                ui.blockDraft = draftFor(block)
                ui.blockCaret = null
            }
            seedBlockDraft(type === 'divider' ? null : block)
            actions.commitBlocks(item, next)
            renderAll()
        },
        replaceBlock(item, blockId, type, seed = '') {
            const fresh = createBlock(type, blockId)
            const block = seed ? { ...fresh, ...blockFromText(type, seed) } : fresh
            const blocks = blocksFor(item).map((b) => (b.id === blockId ? block : b))
            ui.blockMenu = null
            if (type === 'divider') { ui.blockEditingId = null; ui.blockDraft = '' } else {
                ui.blockEditingId = blockId
                ui.blockDraft = draftFor(block)
                ui.blockCaret = null
            }
            seedBlockDraft(type === 'divider' ? null : block)
            actions.commitBlocks(item, blocks)
            renderAll()
        },
        // A shorthand ("- ") or a /command typed at the caret becomes a real
        // block. Whatever prose sat above that line stays where it was; the
        // line itself is consumed, and anything right of the caret rides into
        // the new block. One write, so the prose and the new block can never
        // land as two separate commits with a render between them.
        // `split` is supplied by the rich editor, which knows where its own
        // paragraphs are: its caret offset counts RENDERED text, while the
        // draft carries "\n\n" between paragraphs, so the two cannot be
        // measured with the same ruler. The plain textarea path has no such
        // gap — its value IS the draft — and lets this compute the split.
        promoteAtCaret(item, block, type, split = null) {
            const { before, after } = split || splitAtCaret(ui.blockDraft, ui.blockCaret)
            // Nothing above it: the block simply becomes the new type.
            if (!before.trim()) { actions.replaceBlock(item, block.id, type, after); return }
            const fresh = createBlock(type, nextBlockId())
            const seeded = after ? { ...fresh, ...blockFromText(type, after) } : fresh
            const blocks = blocksFor(item).flatMap((b) => (
                b.id === block.id ? [{ ...b, ...blockFromText(b.type, before) }, seeded] : [b]
            ))
            ui.blockMenu = null
            if (type === 'divider') { ui.blockEditingId = null; ui.blockDraft = '' } else {
                ui.blockEditingId = seeded.id
                ui.blockDraft = draftFor(seeded)
                ui.blockCaret = null
            }
            seedBlockDraft(type === 'divider' ? null : seeded)
            actions.commitBlocks(item, blocks)
            renderAll()
        },
        // Switch a heading block between H2 and H3 without leaving the editor.
        setBlockLevel(item, blockId, level) {
            const blocks = blocksFor(item).map((b) => (b.id === blockId && b.type === 'heading' ? { ...b, level } : b))
            actions.commitBlocks(item, blocks)
            renderAll()
        },
        deleteBlock(item, blockId) {
            actions.finishBlockAndContinue(item, blockId, true)
        },
        finishBlockAndContinue(item, blockId, remove = false) {
            const current = blocksWithPendingEdit(item)
            const index = current.findIndex((b) => b.id === blockId)
            const blocks = current.filter((b) => b.id !== blockId || (!remove && !isEmptyBlock(b)))
            const next = current.slice(index + 1).find((b) => b.type !== 'divider')
            ui.blockEditingId = null
            root.ownerDocument.activeElement?.blur?.()
            ui.blockDraft = ''
            ui.blockMenu = null
            seedBlockDraft(next || null)
            if (next) {
                ui.blockEditingId = next.id
                ui.blockDraft = draftFor(next)
                ui.blockCaret = 0
                ui.blockFieldFocus = { offset: 0 }
                if (ui.blockTableFocus) ui.blockTableFocus.offset = 0
            }
            actions.commitBlocks(item, blocks)
            renderAll()
            if (!next) queueMicrotask(() => root.querySelector('#ticket-composer')?.focus())
        },
        moveBlock(item, dragId, targetId) {
            if (dragId === targetId) return
            const blocks = blocksFor(item)
            const moved = blocks.find((b) => b.id === dragId)
            if (!moved) return
            const rest = blocks.filter((b) => b.id !== dragId)
            const ti = rest.findIndex((b) => b.id === targetId)
            if (ti < 0) rest.push(moved)
            else rest.splice(ti, 0, moved)
            actions.commitBlocks(item, rest)
        },
        toggleChecklistBlockItem(item, blockId, index) {
            const blocks = blocksFor(item).map((b) => {
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
        setRigor(on, listId = DEFAULT_LIST_ID) {
            return send(RPC_SET_BOARD_CONFIG, { listId, baseKey: listAccess(store.getState(), listId).baseKey, config: { rigorOn: !!on } })
        },
        cycleTheme() {
            store.setPreferences({ theme: nextTheme(store.getState().preferences.theme) })
        },
        summonAddBar() {
            // The add bar only serves the simple-list surfaces (grocery / to-do)
            // and files onto the active list; on a board or system view it's a
            // no-op (the board has its own new-ticket flow).
            if (ui.view !== 'lists' && ui.view !== 'todo') return
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
        // Whole-project invite (every list syncs to whoever joins). Reached only
        // from Settings — deliberately NOT a page-header button, so it can't be
        // hit by reflex when the user meant to share one list (that lives in the
        // per-list settings dialog via shareList).
        shareProject() {
            showInvitationDialog('share')
        },
        regenerateInvite() {
            showInvitationDialog('share')
        },
        // Abort a join that is still pairing. Without this the guest stays behind
        // joinViaInvite's single-flight guard for the rest of its 120s deadline,
        // so a retry with a fresh code re-attaches to the stuck attempt and the
        // OLD failure gets reported against the NEW code.
        async cancelJoin() {
            const res = parseReply(await send(RPC_CANCEL_JOIN))
            // A real cancellation answers { cancelled: true } and the backend
            // broadcasts join-error/'cancelled', which clears this itself.
            if (res?.cancelled) return
            // { cancelled: false } is two different situations and only one of
            // them may dismiss the overlay — see canCancelJoin.
            if (!canCancelJoin(store.getState().joinPhase)) return
            // Nothing was in flight and no broadcast is coming: clear the pane
            // that is otherwise stuck forever.
            store.setState({ isJoining: false })
        },
        refreshNetDiagnostics() {
            return refreshNetDiagnostics()
        },
        // Promote ONE list to its own shared base and show its co-edit invite.
        // Distinct from share() (the whole-project invite): others who join this
        // invite get only this list, not the rest.
        async shareList(listId, { type = null, name = null, builtin = false } = {}) {
            if (!listId) return
            let result = null
            try {
                const reply = await send(RPC_SHARE_LIST, {
                    listId,
                    ...(type ? { type: canonicalSurfaceType(type) } : {}),
                    ...(name ? { name } : {}),
                })
                result = reply ? JSON.parse(reply) : null
            } catch { result = null }
            if (result && result.ok && result.invite) {
                // A named list is already selected while its registry row still
                // describes the personal base. Adopt the authoritative route
                // from this reply now, so an immediate add cannot fall through
                // a not-yet-reconciled listId index in the backend.
                adoptSharedListRoute(ui, { sourceListId: listId, result })
                // Sharing the reserved grocery surface promotes it to a new,
                // ordinary canonical list id. Hide the now-empty source surface
                // through the synced lifecycle channel; recipients then see the
                // promoted list alongside their own default groceries.
                if (builtin && listId === DEFAULT_LIST_ID && !isBoardType(type) && !isTodoType(type)
                    && typeof result.listId === 'string' && result.listId && result.listId !== DEFAULT_LIST_ID) {
                    await setBuiltinVisibility(listId, type || DEFAULT_LIST_TYPE, true)
                    // Promotion moved the owner's rows too. Keep them on that
                    // same list instead of leaving a now-hidden default surface
                    // selected (which would collapse to the empty-list screen).
                    ui.activeListId = result.listId
                    ui.activeType = canonicalSurfaceType(type || DEFAULT_LIST_TYPE)
                    ui.activeBaseKey = result.baseKey || null
                    ui.view = surfaceForType(ui.activeType)
                    ui.selectedTicketId = null
                    ui.ticketDocId = null
                }
                showInvitationDialog('share-list', result.baseKey, [{ key: result.invite, expiresAt: result.expiresAt, singleUse: true }])
            } else if (result && result.reason === 'cannot-share-builtin') {
                // Legacy built-in Board/Todo surfaces still multiplex listId
                // 'default' and cannot be promoted independently.
                store.pushNotice(locale.i18n.t('shareList.builtinBlocked'), 'error')
            } else {
                store.pushNotice(locale.i18n.t('shareList.failed'), 'error')
            }
        },
        // Additively join ONE shared list via its invite (NOT the destructive
        // whole-project join). The rest of your lists stay private.
        async joinList(input) {
            const value = (input || '').trim().replace(/\s+/g, '')
            if (!value) {
                store.pushNotice(locale.i18n.t('invite.notification.emptyManual'), 'error')
                return
            }
            if (store.getState().isJoining) {
                store.pushNotice(locale.i18n.t('invite.notification.alreadyJoining'), 'error')
                return
            }
            closeDialog()
            // Shared-list discovery can take as long as a project join. Keep the
            // existing join overlay visible until the request settles so this
            // path gives the same progress feedback as confirmJoin below.
            store.setState({ isJoining: true })
            let result = null
            try {
                const reply = await send(RPC_JOIN_LIST, { invite: value })
                result = reply ? JSON.parse(reply) : null
            } catch {
                result = null
            } finally {
                store.setState({ isJoining: false })
            }
            if (result?.ok) store.pushNotice(locale.i18n.t('joinList.joined'), 'success')
            else openDialog({ kind: 'join-list', value, errorKey: joinErrorKey(result?.reason) })
        },
        async requestJoin(input) {
            const value = input.trim().replace(/\s+/g, '')
            if (!value) {
                store.pushNotice(locale.i18n.t('invite.notification.emptyManual'), 'error')
                return
            }
            if (store.getState().isJoining) {
                store.pushNotice(locale.i18n.t('invite.notification.alreadyJoining'), 'error')
                return
            }
            // Require a backup password so the current lists are backed up before
            // joining replaces the local base. (A backend hiccup → don't block.)
            const info = await backupRequest(RPC_LIST_BACKUPS)
            // The password check is asynchronous; another join may have started
            // while it was in flight.
            if (store.getState().isJoining) {
                store.pushNotice(locale.i18n.t('invite.notification.alreadyJoining'), 'error')
                return
            }
            ui.backupPasswordSet = !!(info && info.passwordSet)
            if (info && info.passwordSet === false) {
                store.pushNotice(locale.i18n.t('backup.auto.joinNeedsPassword'), 'error')
                openDialog({ kind: 'settings' })
                void refreshCompactionReadiness()
                loadAutoBackups()
                return
            }
            // H2 parity: a join NEVER fires without an explicit confirmation
            // step that explains the base switch.
            openDialog({ kind: 'join-confirm', invite: value })
        },
        confirmJoin(invite) {
            if (store.getState().isJoining) {
                closeDialog()
                store.pushNotice(locale.i18n.t('invite.notification.alreadyJoining'), 'error')
                return
            }
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
        // Desktop-hosted voice on/off (Settings → Voice). Like the leaf bridge,
        // the pref records intent; the worker's voice status is the truth shown.
        async setVoice(enabled) {
            if (typeof client.voice !== 'function') return
            store.setPreferences({ voiceEnabled: enabled })
            const p = store.getState().preferences
            try {
                const status = await client.voice(enabled ? 'start' : 'stop', {
                    modelPath: p.voiceModelPath, locale: p.voiceLocale, prompt: p.voicePrompt,
                })
                if (status) {
                    store.setState({ voice: status })
                    if (enabled && !status.running) store.pushNotice(locale.i18n.t('desktop.voice.startFailed'), 'error')
                }
            } catch {
                store.pushNotice(locale.i18n.t('desktop.voice.startFailed'), 'error')
            }
        },
        setVoiceModelPath(path) { store.setPreferences({ voiceModelPath: (path ?? '').trim() }) },
        setVoiceLocale(value) { store.setPreferences({ voiceLocale: value || 'auto' }) },
    }

    // --- skeleton ----------------------------------------------------------
    // Sidebar zones: brand, the dynamic list rail (groups + lists from the
    // synced registry, rebuilt each render), then status strip + system nav.
    // Servers is a section inside the Peers & Devices pane. Analytics sits
    // directly under Peers & Devices as its own pane again — folding it into
    // Settings buried it in a scrolling dialog. Activity (the backend event log)
    // does NOT get a sidebar entry: it is a Settings sub-page, since it is a
    // diagnostic you open on purpose, not a place you navigate to.
    const SYSTEM_DEFS = [
        { key: 'peers', icon: 'users', label: (t) => t('desktop.nav.peers') },
        { key: 'analytics', icon: 'activity', label: (t) => t('desktop.analytics.title') },
        { key: 'settings', icon: 'settings', label: (t) => t('desktop.nav.settings'), action: () => { openDialog({ kind: 'settings' }); loadAutoBackups(); void refreshCompactionReadiness() } },
    ]

    // --- Value Return -------------------------------------------------------
    // The value-return enable flag is keyed by the canonical surface type, so a
    // board item (whose listType is the legacy wire 'kanban') must be folded to
    // BOARD_LIST_TYPE before keying. Todo/shopping are already canonical.
    const canonicalSurfaceType = (type) => (isBoardType(type) ? BOARD_LIST_TYPE : type)
    const valueSurfaceKey = (listId, type) => surfaceLabelKey(listId, canonicalSurfaceType(type))
    const isValueSurface = (listId, type) => valueSurfaces.has(valueSurfaceKey(listId, type))
    const isValueItem = (item) => !!item && isValueSurface(item.listId, item.listType)
    // The two badges shown on any rated item (card / drawer / todo row / plan row).
    function valueBadges (item) {
        if (!hasValueRating(item)) return []
        const t = locale.i18n.t.bind(locale.i18n)
        return [
            h('span', { class: 'value-badge', title: t('value.value') }, tablerIcon('coins', { size: 13 }), String(clampRate(item.valueRate))),
            h('span', { class: 'value-badge delay', title: t('value.delay') }, tablerIcon('hourglass', { size: 13 }), String(clampRate(item.delayRate))),
        ]
    }
    // The per-surface enable toggle shown in list settings, board/todo only.
    function valueReturnToggleRow (listId, type) {
        if (!(isBoardType(type) || isTodoType(type))) return null
        const t = locale.i18n.t.bind(locale.i18n)
        const on = isValueSurface(listId, type)
        const cb = h('input', { type: 'checkbox', class: 'switch-input', checked: on ? '' : null, onchange: (event) => actions.setValueReturn(listId, type, event.target.checked) })
        return h('div', { class: 'value-toggle' },
            h('label', { class: 'switch-row' },
                h('span', { class: 'switch-text' },
                    h('span', { class: 'switch-title label-sm' }, tablerIcon('coins', { size: 14 }), h('span', {}, t('value.enable'))),
                    h('span', { class: 'switch-hint label-md' }, t('value.enableHint')),
                ),
                h('span', { class: `switch${on ? ' on' : ''}` }, cb, h('span', { class: 'switch-knob' })),
            ),
        )
    }

    const navButtons = {}
    function navButton(def) {
        const btn = h('button', {
            class: `nav-item${def.soon ? ' soon' : ''}`,
            onclick: def.soon
                ? null
                : (def.action ?? (() => {
                    ui.view = def.key
                    // Opening Peers is exactly when someone asks "why is this not
                    // connecting" — probe the transport then, rather than on a
                    // timer that runs while nobody is looking at the answer.
                    if (def.key === 'peers') void refreshNetDiagnostics()
                    renderAll()
                })),
        })
        if (def.soon) btn.setAttribute('aria-disabled', 'true')
        navButtons[def.key] = btn
        return btn
    }
    const railHost = h('nav', { class: 'rail' })
    // The cross-list Overview (day plan) is pinned at the top of the rail, above
    // the list groups. Its active state is driven by ui.view === 'overview'.
    const railPinned = h('nav', { class: 'rail-pinned' },
        navButton({ key: 'overview', icon: 'layout-dashboard', label: (t) => t('desktop.nav.overview') }),
    )
    const sidebar = h('aside', { class: 'sidebar' },
        h('div', { class: 'brand' },
            h('span', { class: 'brand-wordmark' }, 'Listam'),
        ),
        railPinned,
        railHost,
        h('div', { class: 'sidebar-bottom' },
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
    // The ticket detail drawer lives here, a sibling of .shell (NOT inside .main),
    // so its position:fixed resolves against the viewport regardless of any
    // ancestor transform on .main.
    const drawerHost = h('div', {})
    root.append(titlebar, shell, hintsHost, noticesHost, drawerHost, dialogHost)

    function showInvitationDialog(kind, baseKey = null, invites = []) {
        const model = createInvitePanel(invites)
        model.busy = true
        openDialog({ kind, baseKey, invitePanel: model })
        void send(RPC_CREATE_INVITE, { baseKey, listOnly: true }).then((reply) => {
            const result = parseReply(reply)
            if (result?.ok) {
                model.invites = result.invites
                model.qrKey = result.invites.length === 1 ? result.invites[0].key : null
            } else model.error = result || { reason: 'invite-failed' }
        }).catch(() => { model.error = { reason: 'invite-failed' } }).finally(() => {
            model.busy = false
            if (ui.dialog?.invitePanel === model) renderAll()
        })
    }

    async function generateInvitationBatch(model, baseKey) {
        if (model.busy) return
        model.busy = true
        model.error = null
        renderAll()
        try {
            const result = parseReply(await send(RPC_CREATE_INVITE, { baseKey, count: model.count, ttlMs: model.ttlMs }))
            if (result?.ok) {
                const previous = new Map(model.invites.map((invite) => [invite.key, invite]))
                for (const invite of result.invites) previous.set(invite.key, invite)
                model.invites = [...previous.values()]
                model.qrKey = result.invites.length === 1 ? result.invites[0].key : null
            } else model.error = result || { reason: 'invite-failed' }
        } catch { model.error = { reason: 'invite-failed' } }
        finally {
            model.busy = false
            if (ui.dialog?.invitePanel === model) renderAll()
        }
    }

    // A dialog may register an `onClose` hook (the ticket create panel does: it
    // owns a real row and a pending autosave, and both have to settle however
    // the panel goes away). closeDialog is the ONE choke point every dismissal
    // reaches — the backdrop click, the global Escape handler, and each action
    // button — so the hook belongs here rather than on any one of them.
    function openDialog(dialog) {
        runDialogClose()
        ui.dialog = dialog
        if (dialog.kind === 'list-settings') {
            const payload = { listId: dialog.listId, baseKey: listAccess(store.getState(), dialog.listId).baseKey }
            send(RPC_GET_MEMBERS, payload)
            send(RPC_GET_BOARD_CONFIG, payload)
        }
        renderAll()
    }
    function closeDialog() {
        runDialogClose()
        ui.dialog = null
        renderAll()
    }
    function runDialogClose() {
        const hook = ui.dialog?.onClose
        if (typeof hook !== 'function') return
        // Detach before running: the hook writes and pushes notices, which
        // re-render, and it must never be able to re-enter itself.
        ui.dialog.onClose = null
        hook()
    }

    // --- ticket draft autosave ---------------------------------------------
    // The create panel used to hold its fields in a throwaway object on
    // ui.dialog, so every way of dismissing it — a click on the backdrop, the
    // global Escape handler, a background render that swapped the dialog —
    // silently took the half-written ticket with it.
    //
    // So the panel no longer holds the ticket: it OPENS one. newTicket writes a
    // real row (marked `draft: true`) before the dialog is even built, and
    // everything typed after that is an edit of that row. There is no unsaved
    // state left for a dismissal to lose.
    //
    // Writes are coalesced on an idle timer. One append per pause rather than
    // per keystroke matters twice over: each write echoes back through the store
    // and rebuilds the dialog wholesale, so an un-debounced save would have the
    // user typing into a field being torn down under them on every character.
    const TICKET_DRAFT_SAVE_MS = 400
    let ticketDraftTimer = null
    let ticketDraftPending = null

    function writeTicketDraft(draftId, draft, valueOn, { commit = false } = {}) {
        const existing = store.getState().items.find((it) => it && it.id === draftId)
        if (!existing) return false
        const at = now()
        let next = { ...existing, ...ticketDraftFields(draft, valueOn), updatedAt: at }
        if (commit) next = commitDraftTicket(next, at)
        markLocalId(draftId)
        send(RPC_UPDATE, { item: next })
        return true
    }
    function scheduleTicketDraftSave(draftId, draft, valueOn) {
        ticketDraftPending = { draftId, draft, valueOn }
        if (ticketDraftTimer) clearTimeout(ticketDraftTimer)
        ticketDraftTimer = setTimeout(() => {
            ticketDraftTimer = null
            const pending = ticketDraftPending
            ticketDraftPending = null
            if (pending) writeTicketDraft(pending.draftId, pending.draft, pending.valueOn)
        }, TICKET_DRAFT_SAVE_MS)
    }
    function cancelTicketDraftSave() {
        if (ticketDraftTimer) clearTimeout(ticketDraftTimer)
        ticketDraftTimer = null
        ticketDraftPending = null
    }
    // What a dismissal leaves behind is decided in ./ui/ticket-draft.mjs, where
    // node can test it; this is only the write it asks for. Always at most one
    // append, which also flushes whatever the debounce still owed.
    function settleTicketDraft(draftId, draft, valueOn) {
        cancelTicketDraftSave()
        const item = store.getState().items.find((it) => it && it.id === draftId)
        const plan = planTicketDraftSettlement({
            item,
            draft,
            config: selectBoardConfig(listAccess(store.getState(), item?.listId)),
            valueOn,
            isDraft: isDraftTicket(item),
        })
        if (plan === 'none') return
        if (plan === 'delete') {
            markLocalId(draftId)
            send(RPC_DELETE, { item })
            return
        }
        writeTicketDraft(draftId, draft, valueOn, { commit: plan === 'commit' })
    }
    function openTicketDraftDialog(draftId, draft, valueOn) {
        openDialog({
            kind: 'add-ticket',
            draftId,
            draft,
            onClose: () => settleTicketDraft(draftId, draft, valueOn),
        })
    }

    // --- list navigation ----------------------------------------------------
    // A rail *surface* is a (listId, type) pair. Desktop's legacy data lives on
    // a single list (listId 'default') differentiated only by listType, so that
    // list can still yield three compatibility surfaces — Groceries / Board /
    // Todo — sharing listId 'default'. Only Groceries exists on a fresh project;
    // legacy Board/Todo appear when matching content exists. User-created lists
    // are registry-backed on their own listId. The active surface is
    // (ui.activeListId, ui.activeType), and item filtering keys on BOTH so legacy
    // board/todo rows never bleed into the grocery view (and vice-versa).
    const GROCERY_TYPE = 'shopping'
    // A built-in surface's display name: a synced rename override (surface label)
    // if present, else the localized default. `surfaceLabels` is the reduced
    // Map<surfaceKey,name>; pass it in so callers reduce state.items once.
    function builtinDisplayName(type, surfaceLabels) {
        const t = locale.i18n.t.bind(locale.i18n)
        return surfaceLabels.get(surfaceLabelKey(DEFAULT_LIST_ID, type)) || t(builtinFallbackKey(type))
    }
    function surfaceActive(surface) {
        return ui.activeListId === surface.listId && surfaceForType(ui.activeType) === surfaceForType(surface.type)
    }
    // Build the rail: every surface lives in a group. The former built-ins and
    // any list without a (known) group fall into "general", which renders first;
    // named registry groups follow. Memoized per render (state is a fresh object
    // on every store change).
    let navCacheState = null
    let navCacheRail = null
    function buildRail(state) {
        if (navCacheState === state && navCacheRail) return navCacheRail
        const t = locale.i18n.t.bind(locale.i18n)
        const items = state.items
        // Synced rename overrides for the built-in surfaces (reduced once).
        const surfaceLabels = reduceSurfaceLabels(items)
        // Synced group placement for the built-in surfaces (surfaceKey -> groupId).
        const syncedBuiltinGroups = reduceBuiltinGroups(items)
        // Groceries is the only starter surface. Board/Todo on the reserved
        // default bucket are legacy compatibility surfaces and appear only while
        // matching content exists. Grocery deletion is synced and content-aware;
        // Board/Todo retain their older device-local hidden preference.
        const builtins = visibleBuiltinSurfaceTypes(items, state.preferences.hiddenBuiltins)
            .map((type) => ({
                listId: DEFAULT_LIST_ID,
                type,
                name: builtinDisplayName(type, surfaceLabels),
                builtin: true,
            }))

        const registry = reduceRegistry(items)
        // Lists with items but no meta-item (legacy/stray) — filed under general.
        const extras = detectExtraLists(items, registry, (id) => id).filter((l) => l.id !== DEFAULT_LIST_ID)

        // Bucket every surface by group; general (the default) holds anything
        // whose group is general, empty, deleted, or missing. fileSurface stamps
        // each surface with the group it actually landed in (drag reads it).
        const generalSurfaces = []
        const buckets = new Map()
        for (const g of registry.groups) if (g.id !== GENERAL_GROUP_ID) buckets.set(g.id, [])
        const fileSurface = (surface, groupId) => {
            const dest = (groupId && groupId !== GENERAL_GROUP_ID && buckets.has(groupId)) ? groupId : GENERAL_GROUP_ID
            surface.groupId = dest
            if (dest === GENERAL_GROUP_ID) generalSurfaces.push(surface)
            else buckets.get(dest).push(surface)
        }
        // Built-ins first (preserving their fixed order), filed into their group:
        // the synced placement wins when present (its own LWW already resolved),
        // else the device-local cache. fileSurface clamps an unknown/missing group
        // to general, so a stale or not-yet-synced group never strands a surface.
        const localBuiltinGroups = (state.preferences.builtinGroups && typeof state.preferences.builtinGroups === 'object') ? state.preferences.builtinGroups : {}
        for (const b of builtins) {
            const sk = surfaceLabelKey(DEFAULT_LIST_ID, b.type)
            fileSurface(b, syncedBuiltinGroups.has(sk) ? syncedBuiltinGroups.get(sk) : localBuiltinGroups[sk])
        }
        for (const l of registry.lists) {
            if (l.id === DEFAULT_LIST_ID) continue
            // `baseKey` (from the registry's regBaseKey) marks a list that lives in
            // its own shared base; it drives the shared badge and routes the list's
            // writes to that base (selectSurface → ui.activeBaseKey).
            fileSurface({ listId: l.id, type: l.type || GROCERY_TYPE, name: l.name || l.id, builtin: false, baseKey: l.baseKey ?? null }, l.groupId)
        }
        for (const l of extras) {
            fileSurface({ listId: l.id, type: l.type || GROCERY_TYPE, name: l.name || l.id, builtin: false, baseKey: null }, null)
        }

        const generalName = registry.groups.find((g) => g.id === GENERAL_GROUP_ID)?.name || t('desktop.group.general')
        const groups = [{ id: GENERAL_GROUP_ID, name: generalName, surfaces: generalSurfaces, general: true }]
        for (const g of registry.groups) {
            if (g.id === GENERAL_GROUP_ID) continue
            groups.push({ id: g.id, name: g.name, surfaces: buckets.get(g.id) || [], general: false })
        }
        navCacheRail = { groups }
        navCacheState = state
        return navCacheRail
    }
    function allSurfaces(rail) {
        return rail.groups.flatMap((g) => g.surfaces)
    }
    // The desktop opens with NO list selected. Only drop a stale selection (the
    // active list was deleted); never auto-select a surface.
    function ensureActiveList(state) {
        const rail = buildRail(state)
        if (ui.activeListId != null && !allSurfaces(rail).some(surfaceActive)) {
            ui.activeListId = null
            ui.activeType = null
            ui.activeBaseKey = null
            if (ui.view === 'board' || ui.view === 'todo' || ui.view === 'notes') ui.view = 'lists'
        }
        return rail
    }
    function activeSurface(state) {
        return allSurfaces(buildRail(state)).find(surfaceActive) ?? null
    }
    function itemsForActiveList(state) {
        const pred = typePredicate(ui.activeType)
        return state.items.filter((item) => item.listId === ui.activeListId && pred(item))
    }
    function selectSurface(state, surface) {
        // If the target lives in a collapsed group, expand it so its now-active
        // row is actually visible in the rail — otherwise selecting via the
        // [ / ] surface-cycling shortcut would leave a live selection with no
        // highlighted row anywhere. (buildRail stamps every surface with groupId.)
        if (surface.groupId && isGroupCollapsed(store.getState(), surface.groupId)) {
            actions.toggleGroupCollapsed(surface.groupId)
        }
        ui.activeListId = surface.listId
        ui.activeType = surface.type
        ui.activeBaseKey = surface.baseKey ?? null
        ui.view = surfaceForType(surface.type)
        ui.selectedTicketId = null
        ui.ticketDocId = null
        ui.activeNoteId = null
        ui.noteQuery = ''
        ui.editingListId = null
        ui.editingSurfaceKey = null
        ui.editingGroupId = null
        renderAll()
    }

    // --- renderers ----------------------------------------------------------
    // The badge count for one surface, scoped to its (listId,type): in-progress
    // tickets for a board, otherwise remaining (not-done) items.
    function surfaceBadgeCount(state, surface) {
        const pred = typePredicate(surface.type)
        const scoped = state.items.filter((item) => item.listId === surface.listId && pred(item))
        if (isBoardType(surface.type)) return scoped.filter((item) => item.status === 'in_progress').length
        return selectSummary(scoped).remaining
    }
    // The remaining/in-progress badge for one surface, scoped to its (listId,type).
    function surfaceBadge(state, surface) {
        const count = surfaceBadgeCount(state, surface)
        return h('span', { class: `badge${count === 0 ? ' zero' : ''}` }, String(count))
    }
    // Sum of every surface's badge count in a group — shown on the group header
    // when it is collapsed (the per-surface badges are then hidden).
    function groupBadgeCount(state, group) {
        return group.surfaces.reduce((sum, surface) => sum + surfaceBadgeCount(state, surface), 0)
    }
    function isGroupCollapsed(state, groupId) {
        const map = state.preferences.collapsedGroups
        return !!(map && typeof map === 'object' && map[groupId])
    }
    // Focus a freshly-rendered inline-rename input (editableText only restores
    // focus across re-renders, not on first entry into edit mode), and select
    // its text so typing replaces the current name.
    function focusRailRename(id) {
        queueMicrotask(() => {
            const el = root.querySelector(`#${CSS.escape(id)}`)
            if (el) { el.focus(); el.select?.() }
        })
    }
    // A small hover-revealed "⋮" button (desktop has no native context menus).
    function rowMenuButton(label, onClick) {
        return h('button', {
            class: 'rail-row-menu-btn',
            'aria-label': label,
            title: label,
            onclick: (event) => { event.stopPropagation(); onClick() },
        }, tablerIcon('dots', { size: 14 }))
    }
    function renderSurfaceRow(state, surface) {
        const t = locale.i18n.t.bind(locale.i18n)
        const { listId, type, name, builtin } = surface
        const fromGroupId = surface.groupId ?? GENERAL_GROUP_ID
        // Built-ins rename via a synced surface-label item (they share one listId,
        // so they have no registry meta-item); registry lists rename their meta-
        // item. The two use distinct edit-state keys and distinct, colon-free DOM
        // ids (a surfaceKey contains ':', which would break editableText's raw
        // querySelector focus-restore).
        const editKey = surfaceLabelKey(listId, type)
        const editing = builtin ? ui.editingSurfaceKey === editKey : ui.editingListId === listId
        const domId = builtin ? `rail-rename-builtin-${type}` : `rail-rename-${listId}`
        const enterEdit = builtin
            ? () => { ui.editingSurfaceKey = editKey; renderAll(); focusRailRename(domId) }
            : () => { ui.editingListId = listId; renderAll(); focusRailRename(domId) }
        if (editing) {
            const input = editableText({
                id: domId,
                value: name,
                className: 'rail-rename-input',
                onCommit: (v) => {
                    const nv = v.trim()
                    if (builtin) { if (nv !== name) actions.renameBuiltin(listId, type, nv); ui.editingSurfaceKey = null }
                    else { if (nv && nv !== name) actions.renameList(listId, nv); ui.editingListId = null }
                    renderAll()
                },
            })
            return h('div', { class: 'rail-row editing' },
                h('div', { class: 'nav-item' }, tablerIcon(iconForType(type), { size: 15 }), input),
            )
        }
        return h('div', {
            class: 'rail-row',
            // Drag a list onto another group to move it there (see renderRail's
            // group drop zones). The whole row is the drag handle.
            draggable: 'true',
            ondragstart: (event) => {
                ui.railDrag = { listId, type, builtin, fromGroupId }
                event.dataTransfer.effectAllowed = 'move'
                try { event.dataTransfer.setData('text/plain', listId) } catch { /* some platforms reject */ }
                event.currentTarget.classList.add('dragging')
            },
            ondragend: (event) => { event.currentTarget.classList.remove('dragging'); ui.railDrag = null },
        },
            h('button', {
                class: `nav-item${surfaceActive(surface) ? ' active' : ''}`,
                onclick: () => selectSurface(state, surface),
                ondblclick: enterEdit,
            },
                tablerIcon(iconForType(type), { size: 15 }),
                h('span', { class: 'nav-label' }, name),
                surface.baseKey ? h('span', { class: 'nav-shared', title: t('shareList.shared') }, tablerIcon('users', { size: 12 })) : null,
                surfaceBadge(state, surface),
            ),
            rowMenuButton(t('desktop.list.settings'), () => openDialog(
                builtin ? { kind: 'list-settings', listId, builtinType: type } : { kind: 'list-settings', listId },
            )),
        )
    }
    function renderGroupHeader(state, group) {
        const t = locale.i18n.t.bind(locale.i18n)
        if (ui.editingGroupId === group.id) {
            const input = editableText({
                id: `rail-grp-rename-${group.id}`,
                value: group.name,
                className: 'rail-rename-input',
                onCommit: (v) => { const nv = v.trim(); if (nv && nv !== group.name) actions.renameGroup(group.id, nv); ui.editingGroupId = null; renderAll() },
            })
            return h('div', { class: 'rail-row rail-group-row editing' }, input)
        }
        const collapsed = isGroupCollapsed(state, group.id)
        // Collapsed groups roll up their surfaces' badges into one count on the
        // header; expanded groups show no header badge (each surface has its own).
        const rolled = collapsed ? groupBadgeCount(state, group) : 0
        return h('div', { class: `rail-row rail-group-row${collapsed ? ' collapsed' : ''}` },
            h('button', {
                class: 'rail-group-toggle',
                'aria-label': collapsed ? t('desktop.group.expand') : t('desktop.group.collapse'),
                'aria-expanded': collapsed ? 'false' : 'true',
                onclick: () => actions.toggleGroupCollapsed(group.id),
            }, tablerIcon('chevron-down', { size: 14 })),
            h('div', {
                class: 'rail-group-header label-sm',
                ondblclick: () => { ui.editingGroupId = group.id; renderAll(); focusRailRename(`rail-grp-rename-${group.id}`) },
            }, group.name),
            collapsed
                ? h('span', { class: `badge rail-group-badge${rolled === 0 ? ' zero' : ''}` }, String(rolled))
                : null,
            rowMenuButton(t('desktop.group.settings'), () => openDialog({ kind: 'group-settings', groupId: group.id })),
        )
    }
    // Move the dragged list into `targetGroupId` (a no-op within the same group).
    // Registry lists patch their synced meta-item; built-ins record a device-local
    // group assignment since they have no meta-item.
    function handleRailDrop(targetGroupId) {
        const drag = ui.railDrag
        ui.railDrag = null
        if (!drag || !targetGroupId || drag.fromGroupId === targetGroupId) return
        if (drag.builtin) actions.setBuiltinGroup(drag.listId, drag.type, targetGroupId)
        else actions.moveListToGroup(drag.listId, targetGroupId)
    }
    function renderRail(state, rail) {
        const t = locale.i18n.t.bind(locale.i18n)
        const sections = []
        // Each group is one drop zone (header + its rows); dropping a dragged list
        // anywhere inside moves it into that group. "general" comes first.
        for (const group of rail.groups) {
            const collapsed = isGroupCollapsed(state, group.id)
            const section = h('section', {
                class: `rail-group${collapsed ? ' collapsed' : ''}`,
                ondragover: (event) => { if (ui.railDrag) { event.preventDefault(); section.classList.add('rail-drop') } },
                ondragleave: (event) => { if (!section.contains(event.relatedTarget)) section.classList.remove('rail-drop') },
                ondrop: (event) => { event.preventDefault(); section.classList.remove('rail-drop'); handleRailDrop(group.id) },
            },
                // groupBadgeCount needs the full surface list, so the header reads
                // the real group (with surfaces), not just {id,name}.
                renderGroupHeader(state, group),
                ...(collapsed ? [] : group.surfaces.map((surface) => renderSurfaceRow(state, surface))),
            )
            sections.push(section)
        }
        sections.push(h('button', {
            class: 'rail-new-btn',
            onclick: () => openDialog({ kind: 'list-create', groupId: GENERAL_GROUP_ID }),
        }, tablerIcon('plus', { size: 14 }), h('span', {}, t('desktop.list.new'))))
        replaceChildren(railHost, ...sections)
    }

    let prevPeerCount = null
    function renderNav(state) {
        const t = locale.i18n.t.bind(locale.i18n)
        const peersChanged = prevPeerCount !== null && prevPeerCount !== state.peerCount
        prevPeerCount = state.peerCount

        renderRail(state, ensureActiveList(state))

        // Pinned Overview entry (above the rail). Badge = items planned for today.
        const overviewBtn = navButtons.overview
        if (overviewBtn) {
            const plannedToday = [...reducePlan(state.items).values()].filter((rec) => rec.plannedFor === toDateKey(now())).length
            overviewBtn.replaceChildren(
                tablerIcon('layout-dashboard', { size: 15 }),
                h('span', { class: 'nav-label' }, t('desktop.nav.overview')),
                h('span', { class: `badge${plannedToday === 0 ? ' zero' : ''}` }, String(plannedToday)),
            )
            overviewBtn.classList.toggle('active', ui.view === 'overview')
        }

        for (const def of SYSTEM_DEFS) {
            const btn = navButtons[def.key]
            btn.replaceChildren(
                tablerIcon(def.icon, { size: 15 }),
                h('span', { class: 'nav-label' }, def.label(t)),
            )
            btn.classList.toggle('active', !def.action && ui.view === def.key)
            if (def.key === 'peers') {
                btn.append(h('span', {
                    class: `badge${state.peerCount === 0 ? ' zero' : ''}${peersChanged ? ' pop' : ''}`,
                }, String(state.peerCount)))
            }
        }
    }

    let prevPane = null
    // Identity of the pane on screen. Both the entrance animation and the
    // focus/caret carry below key off it: a swap is a different surface (no
    // entrance replay is owed to a re-render, no draft is owed to a new pane).
    function mainPaneKey(state) {
        if (state.isJoining) return 'joining'
        // A note is a document with its own title field and block body, so
        // switching notes is a pane SWAP, not a re-render: without the note id in
        // the key the carry below would paste note A's half-typed title into note
        // B (the drawer keys its tickets for exactly this reason).
        const surface = ui.ticketDocId
            ? `doc:${ui.ticketDocId}`
            : ui.view === 'notes'
                ? `notes:${ui.activeListId}:${ui.activeNoteId}`
                : `${ui.view}:${ui.activeListId}`
        return `${surface}:${state.preferences.isGridView}`
    }
    // The main pane is rebuilt wholesale on every store notify, exactly like the
    // drawer and the dialog — and its panes hold real fields (the leaf-bridge
    // port, the voice model/port/locale, the Wi-Fi SSID/passphrase, the server
    // pairing code and name). Without this, a background peer or presence update
    // detached the field being typed into mid-word: focus fell to <body>, the
    // draft was replaced by the canonical value, and the NEXT keystroke was read
    // as a global shortcut instead of text. See ./ui/surface-dom-state.mjs.
    // No scrollSelector: the main pane scrolls the document, not a child of it.
    const mainDom = createSurfaceDomState()
    function renderMain(state) {
        const paneKey = mainPaneKey(state)
        // Capture while the outgoing subtree is still attached. Restoration after
        // the swap is synchronous, so several store notifications in one turn can
        // never leave a gap where the next keystroke lands on <body>.
        const snapshot = mainDom.capture(main, paneKey)
        renderMainPane(state, paneKey)
        mainDom.commit(paneKey)
        mainDom.restore(main, snapshot, {
            restoreContentEditable: (field) => {
                if (ui.blockCaret != null) setRichCaretOffset(field, ui.blockCaret)
            },
        })
    }
    function renderMainPane(state, paneKey) {
        // Pane swaps (view change, list/grid flip, entering the full-screen
        // ticket doc) get an entrance; ordinary state updates re-render in place
        // without re-animating.
        if (prevPane !== paneKey) {
            prevPane = paneKey
            main.classList.remove('pane-enter')
            void main.offsetWidth
            main.classList.add('pane-enter')
        }
        // Expose the active view so panes can scope layout rules without a
        // wrapper element (children render directly into `main`).
        main.dataset.view = ui.ticketDocId ? 'doc' : ui.view
        // Joining is a workspace-wide operation. Render the same loading pane
        // regardless of which surface launched it (list joins normally start
        // from Peers, while project joins may start from any pane).
        if (state.isJoining) return replaceChildren(main, renderJoinOverlay(state))
        if (ui.ticketDocId) return renderTicketFull(state)
        if (ui.view === 'overview') return renderOverviewPane(state)
        // A list surface ('lists' | 'board' | 'todo' | 'notes') needs an active
        // list; with none selected (launch, or the active list was just deleted)
        // show the "pick or create a list" placeholder instead.
        const isListSurface = ui.view === 'lists' || ui.view === 'board' || ui.view === 'todo' || ui.view === 'notes'
        if (isListSurface && ui.activeListId == null) return renderNoListPane(state)
        if (ui.view === 'board') return renderBoardPane(state)
        if (ui.view === 'todo') return renderTodoPane(state)
        if (ui.view === 'notes') return renderNotesPane(state)
        if (ui.view === 'peers') return renderPeersPane(state)
        if (ui.view === 'analytics') return renderAnalyticsPane(state)
        return renderListsPane(state)
    }
    // Shown when no list is selected. The rail still lists every list/group; this
    // is just the main-pane placeholder that invites picking or creating one.
    function renderNoListPane(state) {
        const t = locale.i18n.t.bind(locale.i18n)
        return replaceChildren(main,
            h('div', { class: 'empty-state no-list-empty' },
                h('h2', {}, t('desktop.noList.title')),
                h('p', {}, t('desktop.noList.subtitle')),
                h('button', {
                    class: 'btn btn-primary',
                    onclick: () => openDialog({ kind: 'list-create', groupId: GENERAL_GROUP_ID }),
                }, tablerIcon('plus', { size: 16 }), h('span', {}, t('desktop.list.new'))),
            ),
        )
    }

    let renderedHints = null
    let renderedHintsI18n = null
    let renderedHintsBoard = null
    function renderHints(state) {
        const t = locale.i18n.t.bind(locale.i18n)
        const show = state.preferences.showKeyHints
        shell.classList.toggle('has-hints', show)
        // The footer is independent of list/backend state. Keeping the same DOM
        // node across background updates prevents its entrance animation from
        // restarting and preserves keyboard focus on its close button.
        // The board earns one different hint, so the view is part of the cache
        // key — otherwise the bar keeps whichever one it rendered first.
        const boardView = ui.view === 'board'
        if (renderedHints === show && renderedHintsI18n === locale.i18n && renderedHintsBoard === boardView) return
        renderedHints = show
        renderedHintsI18n = locale.i18n
        renderedHintsBoard = boardView
        if (!show) {
            hintsHost.replaceChildren()
            return
        }
        const hints = [
            ['N', t('desktop.hints.add')],
            ['G', t('desktop.hints.view')],
            ['[ ]', t('desktop.hints.list')],
            // Space toggles done on a list row; on a board there is nothing to
            // toggle, so the slot advertises the key that does work there.
            boardView ? ['↵', t('desktop.shortcuts.openTicket')] : ['Space', t('desktop.hints.done')],
            ['F', t('desktop.hints.flag')],
            ['Del', t('desktop.hints.delete')],
            ['⌘Z', t('desktop.hints.undo')],
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
                if (!actions.addItemGated(text)) {
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

    const { renderOverviewPane } = createOverviewSection({
        main,
        store,
        locale,
        ui,
        actions,
        now,
        renderAll,
        openDialog,
        selectSurface,
        builtinDisplayName,
        typePredicate,
        iconForType,
        dropBefore,
        valueBadges,
        beacon,
    })
    function renderListsPane(state) {
        const t = locale.i18n.t.bind(locale.i18n)
        const { preferences } = state
        const items = itemsForActiveList(state)
        const summary = selectSummary(items)
        const title = activeSurface(state)?.name || t('desktop.rail.groceries')

        const statusKey = connectionStatusKey(state)

        replaceChildren(main,
            h('header', { class: 'page-header' },
                h('h1', { class: 'page-title title-lg' }, title),
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
                    h('button', {
                        class: `btn btn-secondary btn-icon${plannedRefs.has(planListKey(ui.activeListId, ui.activeType)) ? ' active' : ''}`,
                        'aria-label': t('plan.flagList'),
                        title: t('plan.flagList'),
                        onclick: () => actions.toggleListPlan(ui.activeListId, ui.activeType),
                    }, tablerIcon('flag', { size: 16 })),
                    h('button', {
                        class: `btn btn-secondary btn-icon${ui.inspectorItemId ? ' active' : ''}`,
                        'aria-label': t('inspector.toggle'),
                        title: `${t('inspector.toggle')} (I)`,
                        onclick: () => { const id = ui.focusedItemId || (items[0] && items[0].id); if (id) actions.toggleInspector(id) },
                    }, tablerIcon('info-circle', { size: 16 })),
                ),
            ),
            renderAddBar(t),
            h('div', { class: 'summary-bar label-md' },
                beacon(state),
                h('span', {}, t(statusKey, { count: state.peerCount })),
                h('span', {}, summary.remaining === 0 && summary.total > 0
                    ? t('main.summary.allDone')
                    : t('main.summary.itemsLeft', { count: summary.remaining })),
                summary.done > 0
                    ? h('button', { class: 'btn btn-secondary', onclick: actions.clearDone }, t('main.summary.clearDone'))
                    : null,
            ),
            items.length === 0 ? renderEmptyState() : renderItems(state, items),
        )
    }

    // The to-do surface: a flat plain-text list. No category grouping, no grid,
    // no grocery item icons — just checkbox rows. Mirrors the grocery pane but
    // deliberately omits the grid toggle and the category machinery.
    function renderTodoPane(state) {
        const t = locale.i18n.t.bind(locale.i18n)
        const items = sortByOrder(itemsForActiveList(state))
        const summary = selectSummary(items)
        const title = activeSurface(state)?.name || t('desktop.rail.todo')
        const statusKey = connectionStatusKey(state)

        replaceChildren(main,
            h('header', { class: 'page-header' },
                h('h1', { class: 'page-title title-lg' }, title),
                h('div', { class: 'header-actions' },
                    h('button', {
                        class: 'btn btn-secondary btn-icon',
                        'aria-label': t('desktop.header.addItem'),
                        title: `${t('desktop.header.addItem')} (N)`,
                        onclick: actions.summonAddBar,
                    }, tablerIcon('plus', { size: 16 })),
                    h('button', {
                        class: `btn btn-secondary btn-icon${plannedRefs.has(planListKey(ui.activeListId, ui.activeType)) ? ' active' : ''}`,
                        'aria-label': t('plan.flagList'),
                        title: t('plan.flagList'),
                        onclick: () => actions.toggleListPlan(ui.activeListId, ui.activeType),
                    }, tablerIcon('flag', { size: 16 })),
                    h('button', {
                        class: `btn btn-secondary btn-icon${ui.inspectorItemId ? ' active' : ''}`,
                        'aria-label': t('inspector.toggle'),
                        title: `${t('inspector.toggle')} (I)`,
                        onclick: () => { const id = ui.focusedItemId || (items[0] && items[0].id); if (id) actions.toggleInspector(id) },
                    }, tablerIcon('info-circle', { size: 16 })),
                ),
            ),
            renderAddBar(t),
            h('div', { class: 'summary-bar label-md' },
                beacon(state),
                h('span', {}, t(statusKey, { count: state.peerCount })),
                h('span', {}, summary.remaining === 0 && summary.total > 0
                    ? t('main.summary.allDone')
                    : t('main.summary.itemsLeft', { count: summary.remaining })),
                summary.done > 0
                    ? h('button', { class: 'btn btn-secondary', onclick: actions.clearDone }, t('main.summary.clearDone'))
                    : null,
            ),
            items.length === 0
                ? renderEmptyState()
                : h('div', { class: 'item-rows' },
                    ...items.map((item, i) => renderItemRow(item, tablerIcon(item.isDone ? 'square-check' : 'square', { size: 18 }), items, i)),
                ),
        )
    }

    // The notes surface: an index on the left, the open note as a document on
    // the right. A note is NOT put in the Inspector drawer — a drawer annotates
    // a row, and a note IS the content — so it takes the whole content column.
    // `isDone` on a note means ARCHIVED, not done: archived rows recede but are
    // never struck through, and no row carries a checkbox, because a single
    // click opens the note and there is nothing for a toggle to do.
    function renderNotesPane(state) {
        const t = locale.i18n.t.bind(locale.i18n)
        const notes = itemsForActiveList(state)
        const listName = activeSurface(state)?.name || t('desktop.rail.notes')
        // "Pinned" is the day-plan flag — the same star F toggles on a focused
        // row and the Overview reads — so the index invents no pin channel.
        const groups = projectNotes(notes, {
            isPinned: (note) => plannedRefs.has(planItemKey(note.listId, note.id)),
            query: ui.noteQuery,
        })
        // The open note resolves against ALL notes, not the filtered index: a
        // search that hides the row must not close the document under it.
        const open = notes.find((note) => note.id === ui.activeNoteId) ?? null
        const statusKey = connectionStatusKey(state)

        replaceChildren(main,
            h('header', { class: 'page-header' },
                // The breadcrumb names the level above the h1: the list while a
                // note is open (the h1 is then the note's own title, editable in
                // place), the surface itself while none is.
                h('div', { class: 'notes-head' },
                    h('span', { class: 'notes-crumb label-sm' }, open ? listName : t('desktop.rail.notes')),
                    open
                        ? editableText({
                            id: 'note-title',
                            value: open.text || '',
                            placeholder: t('desktop.notes.untitled'),
                            className: 'notes-title-field title-lg',
                            onCommit: (v) => actions.editItem(open, v),
                        })
                        : h('h1', { class: 'page-title title-lg' }, listName),
                ),
                h('div', { class: 'header-actions' },
                    h('button', {
                        class: 'btn btn-secondary btn-icon',
                        'aria-label': t('desktop.notes.new'),
                        title: `${t('desktop.notes.new')} (N)`,
                        onclick: () => actions.newNote(),
                    }, tablerIcon('plus', { size: 16 })),
                    h('button', {
                        class: `btn btn-secondary btn-icon${plannedRefs.has(planListKey(ui.activeListId, ui.activeType)) ? ' active' : ''}`,
                        'aria-label': t('plan.flagList'),
                        title: t('plan.flagList'),
                        onclick: () => actions.toggleListPlan(ui.activeListId, ui.activeType),
                    }, tablerIcon('flag', { size: 16 })),
                    // Archiving IS the isDone write, so it goes through the same
                    // toggle — and earns the same undo entry — as every other
                    // item's done flag. Only the wording and the row treatment
                    // differ, because a note is filed rather than finished.
                    open
                        ? h('button', {
                            class: `btn btn-secondary btn-icon${isArchivedNote(open) ? ' active' : ''}`,
                            'aria-label': isArchivedNote(open) ? t('desktop.notes.unarchive') : t('desktop.notes.archive'),
                            title: isArchivedNote(open) ? t('desktop.notes.unarchive') : t('desktop.notes.archive'),
                            onclick: () => actions.toggleItem(open),
                        }, tablerIcon('package', { size: 16 }))
                        : null,
                    // Archiving files a note; this throws it away. Without it a
                    // note made by a stray N would have no way out at all —
                    // there is no row-level delete on an index row. Undoable
                    // (⌘Z) like every other item delete.
                    open
                        ? h('button', {
                            class: 'btn btn-secondary btn-icon',
                            'aria-label': t('main.item.delete'),
                            title: t('main.item.delete'),
                            onclick: () => { ui.activeNoteId = null; actions.deleteItem(open) },
                        }, tablerIcon('trash', { size: 16 }))
                        : null,
                ),
            ),
            h('div', { class: 'summary-bar label-md' },
                beacon(state),
                h('span', {}, t(statusKey, { count: state.peerCount })),
                groups.pinned.length ? h('span', {}, `${t('desktop.notes.pinned')} ${groups.pinned.length}`) : null,
                h('span', {}, `${t('desktop.notes.recent')} ${groups.recent.length}`),
                groups.archived.length ? h('span', {}, `${t('desktop.notes.archived')} ${groups.archived.length}`) : null,
            ),
            h('div', { class: 'notes-split' },
                renderNotesIndex(t, groups, notes.length),
                open
                    ? renderNoteDocument(t, open)
                    : h('div', { class: 'empty-state notes-doc-empty' },
                        h('h2', {}, t(notes.length ? 'desktop.notes.none' : 'desktop.notes.empty')),
                        h('p', {}, t('desktop.notes.emptyHint')),
                        notes.length
                            ? null
                            : h('button', { class: 'btn btn-primary', onclick: () => actions.newNote() },
                                tablerIcon('plus', { size: 16 }), h('span', {}, t('desktop.notes.new'))),
                    ),
            ),
        )
    }

    // Row and document timestamps. Fixture and legacy rows carry a counter
    // rather than a clock in updatedAt (see the Inspector footer), so only a
    // real wall-clock value earns a relative time.
    const noteStamp = (note) => (note.updatedAt > 1e12 ? relativeTime(now() - note.updatedAt) : '')

    // The index column: a search field, then Pinned / Recent / Archived.
    function renderNotesIndex(t, groups, total) {
        const shown = groups.pinned.length + groups.recent.length + groups.archived.length
        return h('aside', { class: 'notes-index' },
            h('input', {
                class: 'input',
                id: 'note-search',
                value: ui.noteQuery,
                placeholder: t('desktop.notes.search'),
                'aria-label': t('desktop.notes.search'),
                // The query lives on `ui`, not in the DOM: a background peer
                // update rebuilds this pane wholesale and would otherwise drop
                // the filter mid-search. The typing itself survives because the
                // main pane carries the focused field's value and caret across
                // the rebuild (mainPaneKey / mainDom).
                oninput: (event) => { ui.noteQuery = event.target.value; renderAll() },
            }),
            shown === 0
                ? h('p', { class: 'notes-index-empty label-md' }, t(total ? 'palette.empty' : 'desktop.notes.empty'))
                : h('div', { class: 'notes-groups' },
                    renderNoteGroup(t, 'desktop.notes.pinned', groups.pinned),
                    renderNoteGroup(t, 'desktop.notes.recent', groups.recent),
                    renderNoteGroup(t, 'desktop.notes.archived', groups.archived),
                ),
        )
    }

    function renderNoteGroup(t, labelKey, notes) {
        if (notes.length === 0) return null
        return h('section', { class: 'notes-group' },
            h('h3', { class: 'category-heading label-sm' }, t(labelKey)),
            ...notes.map((note) => renderNoteRow(t, note)),
        )
    }

    // One index row. A PLAIN note is title + timestamp; a note that has grown a
    // block body adds the one-line excerpt and its block count. Focusing a row
    // sets focusedItemId, so ↑/↓ walk the index and F pins the note.
    function renderNoteRow(t, note) {
        const blocks = noteBlockCount(note)
        const excerpt = blocks ? noteExcerpt(note) : ''
        const title = (note.text || '').trim()
        const stamp = noteStamp(note)
        return h('button', {
            class: `note-row${ui.activeNoteId === note.id ? ' active' : ''}${isArchivedNote(note) ? ' archived' : ''}`,
            type: 'button',
            dataset: { itemId: note.id },
            onclick: () => actions.openNote(note.id),
            onfocus: () => { ui.focusedItemId = note.id },
        },
            h('span', { class: `note-row-title body-md${title ? '' : ' untitled'}` }, title || t('desktop.notes.untitled')),
            excerpt ? h('span', { class: 'note-row-excerpt label-md' }, excerpt) : null,
            h('span', { class: 'note-row-meta label-sm' },
                stamp ? h('span', {}, stamp) : null,
                blocks ? h('span', {}, t('desktop.notes.blockCount', { count: blocks })) : null,
            ),
        )
    }

    // The document column: a mono meta strip, then the SHARED block body — the
    // same builder the board drawer and the item Inspector use, which is
    // already type-agnostic. Legacy `note` free-text folds into its first
    // markdown block on open (openNote -> foldLegacyText).
    function renderNoteDocument(t, note) {
        const blocks = noteBlockCount(note)
        const stamp = noteStamp(note)
        return h('article', { class: 'notes-doc' },
            h('div', { class: 'notes-doc-meta label-sm' },
                h('span', {}, blocks ? t('desktop.notes.blockCount', { count: blocks }) : t('desktop.notes.plain')),
                isArchivedNote(note) ? h('span', {}, t('desktop.notes.archived')) : null,
                stamp ? h('span', {}, t('inspector.edited', { time: stamp })) : null,
            ),
            renderTicketBody(note, { legacyField: 'note', variant: 'inspector' }),
        )
    }

    // Three people on 4G watched this pane say "Pairing..." for two minutes and
    // then nothing. It now reports the backend's own heartbeat: how long this has
    // been going, whether the network forced a relay, and a way out that actually
    // aborts the attempt instead of leaving it wedged behind the single-flight
    // guard. `elapsedMs` comes from the backend, so no local timer can drift
    // from, or outlive, the real join.
    function renderJoinOverlay(state) {
        const t = locale.i18n.t.bind(locale.i18n)
        const phase = state.joinPhase || 'default'
        const progress = describeJoinProgress(state.joinProgress)
        return h('div', { class: 'join-overlay pane-section' },
            h('h2', { class: 'headline-sm' }, t(`joining.phase.${phase}.title`)),
            h('p', { class: 'phase body-md' }, t(`joining.phase.${phase}.subtitle`)),
            progress
                ? h('p', { class: 'join-elapsed label-md' }, t('joining.elapsed', { seconds: progress.seconds }))
                : null,
            progress?.slow ? h('p', { class: 'join-hint body-md' }, t('joining.hint.slow')) : null,
            progress?.relayed ? h('p', { class: 'join-hint body-md' }, t('joining.hint.relayed')) : null,
            // Only offered while the attempt can actually be stopped: a button
            // that quietly does nothing is the same mute failure this whole
            // change exists to remove.
            canCancelJoin(state.joinPhase)
                ? h('div', { class: 'join-actions' },
                    h('button', { class: 'btn btn-secondary', onclick: () => actions.cancelJoin() }, t('joining.cancel')),
                )
                : null,
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
            ...sections.map((section) => {
                // Reordering is scoped within a category section, so the sibling
                // array passed to each row is that section's entries in order.
                // groupByCategory imposes its own intra-category order, so apply
                // the user's manual `order` on top of it here (sortByOrder keeps
                // not-yet-ordered items in groupByCategory's order).
                const groupItems = sortByOrder(section.items.map(({ entry }) => entry))
                return h('section', { class: 'category-section' },
                    preferences.categoriesEnabled && preferences.categoryHeaders
                        ? h('h3', { class: 'category-heading label-sm' },
                            getDisplayCategoryName(section.canonicalKey, locale.i18n.groceryLocale))
                        : null,
                    preferences.isGridView
                        ? h('div', { class: 'grid-cards' }, ...groupItems.map((entry, i) => renderGridCard(section, entry, groupItems, i)))
                        : h('div', { class: 'item-rows' }, ...groupItems.map((entry, i) => renderItemRow(entry, categoryIcon(section.canonicalKey, { size: 16 }), groupItems, i))),
                )
            }),
        )
    }

    // `glyph` is the leading icon node: a category icon on the grocery surface,
    // a checkbox on the to-do surface. The row's toggle/edit/delete behaviour is
    // identical for both. `group`/`index` are the row's display-ordered sibling
    // array and position, enabling drag-and-drop and Alt+↑/↓ reordering.
    function renderItemRow(item, glyph, group = [], index = 0) {
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

        const props = {
            class: `item-row body-md${item.isDone ? ' done' : ''}${ui.inspectorItemId === item.id ? ' inspecting' : ''}${rowAnimationClass(item)}`,
            tabindex: '0',
            role: 'button',
            'aria-pressed': item.isDone ? 'true' : 'false',
            dataset: { itemId: item.id },
            // While the Inspector is open, a click retargets it to this item
            // instead of toggling done (so you can browse items without checking
            // them off); otherwise click toggles done as usual.
            onclick: () => { if (ui.inspectorItemId) { ui.focusedItemId = item.id; actions.openInspector(item.id) } else actions.toggleItem(item) },
            ondblclick: (event) => {
                event.preventDefault()
                ui.editingItemId = item.id
                renderAll()
            },
            onkeydown: (event) => handleItemKeys(event, item, group, index),
            onfocus: () => { ui.focusedItemId = item.id },
        }
        if (group.length > 1) Object.assign(props, reorderDnd(item, group, index, 'y'))
        const planned = plannedRefs.has(planItemKey(item.listId, item.id))
        // A todo's square is a real, independent completion control. Previously
        // it lived inside the row's click target, so opening the Inspector made
        // the apparent checkbox retarget the Inspector instead of toggling done.
        // Keep row-click browsing while guaranteeing that the square always
        // performs the action its visual and accessible label promise.
        const leading = isTodoItem(item)
            ? h('button', {
                class: 'glyph item-toggle',
                type: 'button',
                'aria-label': t('main.item.toggle'),
                'aria-pressed': item.isDone ? 'true' : 'false',
                onclick: (event) => { event.stopPropagation(); actions.toggleItem(item) },
                onkeydown: (event) => {
                    if (event.key === ' ' || event.key === 'Enter') event.stopPropagation()
                },
                onfocus: () => { ui.focusedItemId = item.id },
            }, glyph)
            : h('span', { class: 'glyph' }, glyph)
        return h('div', props,
            leading,
            h('span', { class: 'item-text' }, item.text),
            hasValueRating(item)
                ? h('div', {
                    class: 'row-value',
                    title: t('value.addRate'),
                    onclick: (event) => { event.stopPropagation(); openDialog({ kind: 'value-rate', mode: 'edit', item, valueRate: clampRate(item.valueRate), delayRate: clampRate(item.delayRate) }) },
                }, ...valueBadges(item))
                : null,
            h('div', { class: 'row-actions' },
                h('button', {
                    class: 'row-delete',
                    'aria-label': t('main.item.details'),
                    title: `${t('main.item.details')} (I)`,
                    onclick: (event) => {
                        event.stopPropagation()
                        ui.focusedItemId = item.id
                        actions.openInspector(item.id)
                    },
                }, tablerIcon('info-circle', { size: 14 })),
                h('button', {
                    class: `row-flag${planned ? ' flagged' : ''}`,
                    'aria-label': planned ? t('plan.inPlan') : t('plan.flag'),
                    title: planned ? t('plan.inPlan') : `${t('plan.flag')} (today)`,
                    onclick: (event) => {
                        event.stopPropagation()
                        actions.toggleItemPlan(item)
                    },
                }, tablerIcon('flag', { size: 14 })),
                h('button', {
                    class: 'row-flag row-flag-more',
                    'aria-label': t('plan.planFor'),
                    title: t('plan.planFor'),
                    onclick: (event) => {
                        event.stopPropagation()
                        openDialog({ kind: 'plan-day', item })
                    },
                }, tablerIcon('chevron-down', { size: 13 })),
                h('button', {
                    class: 'row-delete',
                    'aria-label': t('main.item.move'),
                    title: t('main.item.move'),
                    onclick: (event) => {
                        event.stopPropagation()
                        openDialog({ kind: 'item-move', item })
                    },
                }, tablerIcon('switch-horizontal', { size: 14 })),
                h('button', {
                    class: 'row-delete',
                    'aria-label': t('main.item.delete'),
                    onclick: (event) => {
                        event.stopPropagation()
                        actions.deleteItem(item)
                    },
                }, tablerIcon('x', { size: 14 })),
            ),
        )
    }

    function renderGridCard(section, item, group = [], index = 0) {
        const t = locale.i18n.t.bind(locale.i18n)
        const props = {
            class: `grid-card${item.isDone ? ' done' : ''}${rowAnimationClass(item)}`,
            style: 'position: relative;',
            tabindex: '0',
            role: 'button',
            'aria-pressed': item.isDone ? 'true' : 'false',
            dataset: { itemId: item.id },
            onclick: () => actions.toggleItem(item),
            onkeydown: (event) => handleItemKeys(event, item, group, index),
            onfocus: () => { ui.focusedItemId = item.id },
        }
        if (group.length > 1) Object.assign(props, reorderDnd(item, group, index, 'x'))
        const planned = plannedRefs.has(planItemKey(item.listId, item.id))
        return h('div', props,
            h('span', { class: 'glyph' }, categoryIcon(section.canonicalKey, { size: 24 })),
            h('span', { class: 'item-text label-md' }, item.text),
            h('button', {
                class: `row-flag${planned ? ' flagged' : ''}`,
                style: 'position: absolute; top: 4px; left: 4px;',
                'aria-label': planned ? t('plan.inPlan') : t('plan.flag'),
                title: planned ? t('plan.inPlan') : `${t('plan.flag')} (today)`,
                onclick: (event) => {
                    event.stopPropagation()
                    actions.toggleItemPlan(item)
                },
            }, tablerIcon('flag', { size: 14 })),
            h('button', {
                class: 'row-delete',
                style: 'position: absolute; top: 4px; right: 4px;',
                'aria-label': t('main.item.move'),
                title: t('main.item.move'),
                onclick: (event) => {
                    event.stopPropagation()
                    openDialog({ kind: 'item-move', item })
                },
            }, tablerIcon('switch-horizontal', { size: 14 })),
        )
    }

    // `group`/`index` (when present) enable Alt+↑/↓ to move the focused item
    // within its display-ordered sibling array. stopPropagation keeps the plain
    // ↑/↓ focus-mover (the document-level handler) from also firing.
    function handleItemKeys(event, item, group = null, index = -1) {
        if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
            if (!Array.isArray(group) || group.length < 2) return
            event.preventDefault()
            event.stopPropagation()
            reorderItemByStep(group, item, event.key === 'ArrowDown' ? 1 : -1)
        } else if (event.key === ' ' || event.key === 'Enter' || event.key === 'x') {
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
        const listId = ui.activeListId || DEFAULT_LIST_ID
        const baseKey = listAccess(store.getState(), listId).baseKey
        const key = baseKey || 'personal'
        if (ui.boardConfigRequested === key) return
        ui.boardConfigRequested = key
        send(RPC_GET_BOARD_CONFIG, { listId, baseKey })
    }

    // ticketInitials / nameInitials / shortKey are imported from
    // @listam/domain/peer-display; `shortKey` was duplicated in listam-mobile's
    // MembersDialog.
    //
    // Memoize the synced peer-label Map per render pass: store.getState().items is
    // a stable reference until the next state update, so we only re-reduce when it
    // actually changes (the board renders many cards, each resolving names).
    let _peerLabelItems = null
    let _peerLabelMap = null
    function peerLabelMap() {
        const items = store.getState().items
        if (items !== _peerLabelItems) { _peerLabelItems = items; _peerLabelMap = reducePeerLabels(items) }
        return _peerLabelMap
    }
    // --- Presence: per-peer online / last-seen / last-ping / avg-online, reduced
    // (memoized like labels) from the synced heartbeat channel that rides state.items. ---
    let _presenceItems = null
    let _presenceMap = null
    function presenceMap() {
        const items = store.getState().items
        if (items !== _presenceItems) { _presenceItems = items; _presenceMap = reducePresence(items) }
        return _presenceMap
    }
    // Presence facts for a writer key: live online flag (heartbeat within the
    // threshold), last-active/last-interaction stamps, average online time, and the
    // owner-signed join date carried on the roster.
    function peerPresence(key) {
        const k = String(key || '')
        const entry = presenceMap().get(k) || null
        const roster = store.getState().roster
        const w = (roster?.writers ?? []).find((x) => x.writerKey === k)
        const isSelf = !!w?.isSelf || (!!roster?.localWriterKey && roster.localWriterKey === k)
        return {
            entry,
            online: isDeviceOnline({ isSelf, presence: entry, now: now() }),
            lastActiveAt: entry?.lastActiveAt || 0,
            lastInteractionAt: entry?.lastInteractionAt || 0,
            avgOnlineMs: averageOnlineMs(entry),
            joinedAt: (w && typeof w.joinedAt === 'number') ? w.joinedAt : null,
        }
    }
    function presenceDate(ms) {
        try { return locale.i18n.date(Number(ms), { day: 'numeric', month: 'short' }) } catch { return '' }
    }
    // Shape-encoded status dot: breathing acid when online, hollow ring otherwise.
    function presenceDot(key) {
        return h('span', { class: `presence-dot ${peerPresence(key).online ? 'live' : 'off'}` })
    }
    // Mono meta sub-line: "Joined 3 Apr · Active 12s ago · Avg 3h 5m online". Empty
    // string when nothing is known yet (a peer that has not beaten this session).
    function presenceMeta(key) {
        const t = locale.i18n.t.bind(locale.i18n)
        const p = peerPresence(key)
        const parts = []
        if (p.joinedAt) parts.push(t('presence.joined', { date: presenceDate(p.joinedAt) }))
        if (p.lastInteractionAt) parts.push(t('presence.lastPing', { ago: formatAgo(now() - p.lastInteractionAt) }))
        if (p.avgOnlineMs > 0) parts.push(t('presence.avgOnline', { time: formatUptime(p.avgOnlineMs) }))
        return parts.join(' · ')
    }
    // Right-aligned live status: "Online now" (acid) or "Seen 2d ago" (muted).
    // The verdict is decided in @listam/domain/peer-display so both apps agree on
    // it; this only maps the kind to a catalog string and a class.
    function presenceStatus(key) {
        const t = locale.i18n.t.bind(locale.i18n)
        const verdict = presenceStatusVerdict(peerPresence(key), now())
        if (verdict.kind === 'online') return h('span', { class: 'presence-status online' }, t('presence.onlineNow'))
        if (verdict.kind === 'lastSeen') return h('span', { class: 'presence-status' }, t('presence.lastSeen', { ago: verdict.ago }))
        return h('span', { class: 'presence-status' }, '')
    }
    // Resolve a writer/device key to a human display. Synced device name when
    // present (initials from the name); otherwise the self label or a short
    // fingerprint. Used everywhere an assignee/author/member key is shown so the
    // collaborative read of the app is people, not hex. No new sync — reads the
    // same label channel the Members pane already trusts.
    function peerDisplay(key) {
        const k = String(key || '')
        const w = (store.getState().roster?.writers ?? []).find((x) => x.writerKey === k)
        // Everything past this point is pure shaping, and lives in
        // @listam/domain/peer-display so mobile resolves a peer identically.
        return resolvePeerDisplay({
            key: k,
            name: peerLabelMap().get(k) || '',
            isSelf: !!(w && w.isSelf),
            isOwner: !!(w && w.isOwner),
            selfLabel: locale.i18n.t('members.role.self'),
        })
    }
    // A compact, copyable fingerprint of a writer key (first8…last4, mono). Click
    // copies the FULL key. Reuses the existing copyText helper + peers copy strings.
    function fingerprintChip(keyHex) {
        const k = String(keyHex || '')
        return h('button', {
            class: 'fingerprint-chip',
            type: 'button',
            title: locale.i18n.t('desktop.peers.copy'),
            onclick: (event) => { event.stopPropagation(); copyText(k, 'desktop.peers.copied') },
        }, h('span', {}, shortKey(k)), tablerIcon('copy', { size: 12 }))
    }

    // State-is-shape sync beacon (Kinetic Minimalist v2 §4.3). Reads only fields
    // that exist: recovery → attention (danger square), joining → syncing (half
    // disc), peers>0 → live (breathing acid), else local (hollow ring).
    function beaconState(state) {
        return syncBeaconState(state)
    }
    // A clickable beacon → the devices popover (names + roles + count). Used at the
    // four sync/summary sites; the infra dots (server/leaf/roster) keep their own.
    function beacon(state) {
        const t = locale.i18n.t.bind(locale.i18n)
        const bs = beaconState(state)
        return h('button', {
            class: 'beacon-btn',
            type: 'button',
            'aria-label': t(`desktop.beacon.${bs}`),
            title: t(`desktop.beacon.${bs}`),
            onclick: () => openDialog({ kind: 'devices' }),
        }, h('span', { class: `dot ${bs}` }))
    }

    // Coarse, language-neutral "time since" for the Inspector's Edited line.
    function relativeTime(ms) {
        const s = Math.max(0, Math.floor(ms / 1000))
        const m = Math.floor(s / 60)
        if (m < 1) return '1m'
        if (m < 60) return `${m}m`
        const hr = Math.floor(m / 60)
        if (hr < 24) return `${hr}h`
        return `${Math.floor(hr / 24)}d`
    }

    // The ticket selected for the split panel / full doc, or null. Filters by
    // listType so a stale id can never surface a grocery row in the detail view.
    function selectedTicket(state) {
        if (!ui.selectedTicketId) return null
        const item = state.items.find((entry) => entry && entry.id === ui.selectedTicketId)
        return item && isBoardType(item.listType) ? item : null
    }

    const pendingBlockWrites = new Map()
    let blockWriteGeneration = 0
    function blocksFor(item) {
        const latest = store.getState().items.find((entry) => entry.id === item.id) || item
        const pending = pendingBlockWrites.get(item.id)
        if (pending?.acknowledged && (latest.updatedAt >= pending.updatedAt || JSON.stringify(latest.blocks) === JSON.stringify(pending.blocks))) {
            pendingBlockWrites.delete(item.id)
        }
        return normalizeBlocks(pendingBlockWrites.get(item.id)?.blocks || latest.blocks)
    }

    // Keep structured payloads intact while their fields are being edited.
    // Only prose, headings, callouts and code use the text draft channel.
    function seedBlockDraft(block) {
        ui.blockStructuredDraft = block && ['checklist', 'numberedList', 'links', 'image'].includes(block.type) ? JSON.parse(JSON.stringify(block)) : null
        ui.blockFieldFocus = null
        ui.blockTableDraft = block && block.type === 'table' ? normalizeTableRows(block.rows) : null
        ui.blockTableFocus = ui.blockTableDraft ? { r: 0, c: 0 } : null
    }

    // The item's blocks with the in-flight draft folded into the block currently
    // being edited — the value commitBlocks should persist. A table folds its
    // grid draft (ui.blockTableDraft); everything else folds the text draft.
    function blocksWithPendingEdit(item) {
        const blocks = blocksFor(item)
        if (!ui.blockEditingId) return blocks
        return blocks.map((b) => {
            if (b.id !== ui.blockEditingId) return b
            if (ui.blockStructuredDraft?.id === b.id) return cleanBlockDraft(ui.blockStructuredDraft)
            if (b.type === 'table' && Array.isArray(ui.blockTableDraft)) {
                const nextRows = normalizeTableRows(ui.blockTableDraft)
                // Only reshape (and thus emit a write) when the grid actually
                // changed. Otherwise leave a legacy/ragged table's stored rows
                // untouched, so merely opening + blurring it never rewrites its
                // shape or bumps updatedAt for every peer.
                if (JSON.stringify(nextRows) === JSON.stringify(normalizeTableRows(b.rows))) return b
                return { ...b, rows: nextRows }
            }
            return { ...b, ...blockFromText(b.type, ui.blockDraft) }
        })
    }

    function renderBoardPane(state) {
        const t = locale.i18n.t.bind(locale.i18n)
        requestBoardConfigOnce()
        const config = selectBoardConfig(listAccess(state, ui.activeListId))
        const columns = groupByStatus(itemsForActiveList(state), config)
        const nowMs = now()
        const board = h('div', { class: 'board-grid' }, ...columns.map((col) => renderBoardColumn(col, nowMs, config.rigorOn)))
        // The ticket detail drawer is rendered into a top-level host (renderDrawerHost)
        // OUTSIDE .main, so its position:fixed is always viewport-relative and never
        // re-anchored by .main's pane-enter transform (which pushed it off-screen).
        replaceChildren(main,
            h('header', { class: 'page-header' },
                h('h1', { class: 'page-title title-lg' }, activeSurface(state)?.name || t('board.title')),
                h('div', { class: 'header-actions' },
                    h('button', {
                        class: 'btn btn-secondary btn-icon',
                        'aria-label': t('board.newTicket'),
                        title: t('board.newTicket'),
                        onclick: () => actions.newTicket(),
                    }, tablerIcon('plus', { size: 16 })),
                    h('button', {
                        class: `btn btn-secondary btn-icon${plannedRefs.has(planListKey(ui.activeListId, ui.activeType)) ? ' active' : ''}`,
                        'aria-label': t('plan.flagList'),
                        title: t('plan.flagList'),
                        onclick: () => actions.toggleListPlan(ui.activeListId, ui.activeType),
                    }, tablerIcon('flag', { size: 16 })),
                ),
            ),
            board,
        )
    }

    // Renders the ticket detail drawer (and its click-away scrim) into the
    // top-level drawerHost — outside .main so the fixed drawer can never be
    // re-anchored by an ancestor transform. Also owns the page scroll-lock.
    // Which drawer kind is currently mounted — the slide-in animation replays
    // only when this changes (opening), never on routine re-renders.
    let mountedDrawerKind = null
    const drawerDom = createSurfaceDomState({ scrollSelector: '.detail-split-scroll, .inspector-body' })
    function renderDrawerHost(state) {
        const show = ui.view === 'board' && !ui.ticketDocId && ui.activeListId != null
        const item = show ? selectedTicket(state) : null
        document.documentElement.classList.toggle('board-drawer-open', !!item)
        if (item) {
            const drawerKey = `ticket:${item.listId || ''}:${item.id}`
            // Capture while the old subtree is still attached. Restoration after
            // the swap is synchronous so several store notifications in one turn
            // can never leave a gap where the next keystroke lands on <body>.
            const snapshot = drawerDom.capture(drawerHost, drawerKey)
            const drawer = renderTicketDrawer(item, state)
            const opening = mountedDrawerKind !== 'ticket'
            if (opening) drawer.classList.add('enter')
            mountedDrawerKind = 'ticket'
            replaceChildren(drawerHost,
                h('div', { class: 'detail-scrim', onclick: () => actions.closeTicket() }),
                drawer,
            )
            drawerDom.commit(drawerKey)
            drawerDom.restore(drawerHost, snapshot, {
                restoreContentEditable: (field) => {
                    if (ui.blockCaret != null) setRichCaretOffset(field, ui.blockCaret)
                },
            })
            // A ticket with nothing written in it opens with the caret already
            // in the composer: there is nothing to read, so the only thing
            // anyone can want is to type. A ticket that HAS a body is opened to
            // be read — taking focus there would scroll it to its own bottom.
            if (opening && blocksFor(item).length === 0) {
                queueMicrotask(() => drawerHost.querySelector('#ticket-composer')?.focus())
            }
            return
        }
        // Non-modal list-item Inspector (grocery/todo). No scrim — the list stays
        // clickable. Drops automatically if the item or surface goes away.
        const inspItem = (ui.view === 'lists' || ui.view === 'todo') && ui.inspectorItemId
            ? state.items.find((it) => it && it.id === ui.inspectorItemId)
            : null
        if (inspItem) {
            const drawerKey = `inspector:${inspItem.listId || ''}:${inspItem.id}`
            const snapshot = drawerDom.capture(drawerHost, drawerKey)
            const insp = renderItemInspector(inspItem, state)
            if (mountedDrawerKind !== 'insp') insp.classList.add('enter')
            mountedDrawerKind = 'insp'
            replaceChildren(drawerHost, insp)
            drawerDom.commit(drawerKey)
            drawerDom.restore(drawerHost, snapshot, {
                restoreContentEditable: (field) => {
                    if (ui.blockCaret != null) setRichCaretOffset(field, ui.blockCaret)
                },
            })
            return
        }
        mountedDrawerKind = null
        drawerDom.clear()
        drawerHost.replaceChildren()
    }

    function renderBoardColumn(col, nowMs, rigorOn = false) {
        const t = locale.i18n.t.bind(locale.i18n)
        const s = col.state
        // groupByStatus keeps arrival order within a column; layer the user's
        // manual `order` on top so within-column drag/keyboard reordering sticks.
        const tickets = sortByOrder(col.tickets)
        const count = s.wipLimit > 0 ? `${tickets.length}/${s.wipLimit}` : String(tickets.length)
        return h('div', {
            // `done` comes from the config, not from the literal id, so a board
            // that renamed its done state still recedes. `empty` narrows a
            // column with nothing in it: 5 default states at 240px overflow a
            // 1440px window, which pushed Done off-screen entirely.
            class: `board-column${s.isDone ? ' done' : ''}${tickets.length === 0 ? ' empty' : ''}`,
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
                ...tickets.map((ticket, i) => renderTicketCard(ticket, nowMs, tickets, i, rigorOn, s.id === 'blocked')),
                h('button', { class: 'board-add', onclick: () => actions.newTicket() },
                    tablerIcon('plus', { size: 14 }), t('board.add')),
            ),
        )
    }

    function renderTicketCard(item, nowMs, group = [], index = 0, rigorOn = false, blocked = false) {
        const t = locale.i18n.t.bind(locale.i18n)
        // Every "which chips does this card earn" rule lives in the model, so
        // it is reachable without a DOM: test/ticket-card-model.test.mjs.
        const m = buildTicketCardModel(item, { now: nowMs, rigorOn, blocked })
        const draftCard = m.draft

        // The meta row is two FIXED groups — who on the left, when on the right
        // — so a field sits in the same place on every card and the eye learns
        // one layout. It never wraps; the secondary numbers live in `extras`,
        // which the card reveals on hover/focus instead of spending a row on.
        const left = []
        // Urgency is carried by the left edge, but an edge is colour alone, so
        // the word rides along in the row. Keyed off `edge` rather than off
        // `priority` so the two can never disagree; medium and low say nothing,
        // which is what makes urgent legible on a board where most are neither.
        if (m.edge === 'urgent' || m.edge === 'high') {
            left.push(h('span', { class: `priority-pill ${m.edge}` }, t(`ticket.priority.${m.edge}`)))
        }
        if (m.assignee) {
            const pd = peerDisplay(m.assignee)
            left.push(h('span', { class: `ticket-avatar${pd.isSelf || pd.isOwner ? ' is-self' : ''}`, title: pd.title }, pd.initials))
        }
        if (m.progress) {
            left.push(h('span', { class: 'ticket-meta', title: t('ticket.detail.tasks') },
                tablerIcon('checklist', { size: 13 }), `${m.progress.done}/${m.progress.total}`))
        }
        if (m.notes > 0) {
            left.push(h('span', { class: 'ticket-meta', title: t('ticket.meta.notes') },
                tablerIcon('notes', { size: 13 }), String(m.notes)))
        }

        const right = []
        if (m.due) {
            right.push(h('span', { class: `ticket-due ${m.due.kind}`, title: t('ticket.due.label') },
                tablerIcon('calendar', { size: 13 }), dueLabel(m.due, { t, locale: locale.i18n.locale })))
        }
        if (m.timer) {
            const pace = m.timer.estimateHours ? ` / ${m.timer.estimateHours}h` : ''
            right.push(h('span', { class: 'ticket-timer' },
                h('span', { class: 'timer-dot' }),
                `${formatDuration(m.timer.ms)}${pace}`))
        }
        if (m.timeliness) {
            const suffix = m.timeliness.delta != null ? ` ${m.timeliness.delta > 0 ? '+' : ''}${m.timeliness.delta}%` : ''
            right.push(h('span', { class: `timeliness-badge ${m.timeliness.kind}` },
                t(`ticket.timeliness.${m.timeliness.kind}`) + suffix))
        }

        const extras = []
        for (const extra of m.extras) {
            if (extra.kind === 'estimate') {
                extras.push(h('span', { class: 'ticket-meta', title: t('ticket.detail.estimate') },
                    tablerIcon('clock', { size: 13 }), `${extra.value}h`))
            } else if (extra.kind === 'complexity') {
                extras.push(h('span', { class: 'ticket-meta', title: t('ticket.detail.complexity') },
                    tablerIcon('activity', { size: 13 }), String(extra.value)))
            }
        }
        // Value/delay keep their own renderer so the card, the list row and the
        // inspector all draw them the same way.
        if (m.extras.some((extra) => extra.kind === 'value')) extras.push(...valueBadges(item))
        // Cards carry the cross-column drag (ui.boardDrag → column drop changes
        // status) AND within-column reorder: when the dragged card belongs to
        // this column, the card itself becomes the drop target (midpoint =
        // before/after); otherwise it stays inert so the event bubbles to the
        // column's status-change drop.
        const inColumn = (drag) => drag && group.some((ticket) => ticket && ticket.id === drag.id)
        return h('article', {
            class: `ticket-card${draftCard ? ' draft' : ''}${m.done ? ' done' : ''}${m.edge ? ` edge-${m.edge}` : ''}${ui.selectedTicketId === item.id ? ' selected' : ''}`,
            tabindex: '0',
            role: 'button',
            'aria-label': m.title || t('ticket.draft.untitled'),
            draggable: 'true',
            dataset: { itemId: item.id, status: item.status || 'todo' },
            onclick: () => actions.openTicket(item.id),
            onkeydown: (event) => {
                if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown') && group.length > 1) {
                    event.preventDefault()
                    event.stopPropagation()
                    reorderItemByStep(group, item, event.key === 'ArrowDown' ? 1 : -1)
                    return
                }
                // The card is an <article>, so Enter and Space are not free the
                // way they are on a <button>: without this a focused card could
                // only ever be opened with the mouse.
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    event.stopPropagation()
                    actions.openTicket(item.id)
                }
            },
            onfocus: () => { ui.focusedItemId = item.id },
            ondragstart: (event) => {
                ui.boardDrag = { id: item.id, fromStatus: item.status || 'todo' }
                event.dataTransfer.effectAllowed = 'move'
                try { event.dataTransfer.setData('text/plain', item.id) } catch { /* some platforms reject */ }
                event.currentTarget.classList.add('dragging')
            },
            ondragend: (event) => { event.currentTarget.classList.remove('dragging', 'drop-before', 'drop-after'); ui.boardDrag = null },
            ondragover: (event) => {
                const drag = ui.boardDrag
                if (!inColumn(drag) || drag.id === item.id) return
                event.preventDefault()
                event.stopPropagation()
                const before = dropBefore(event, 'y')
                event.currentTarget.classList.toggle('drop-before', before)
                event.currentTarget.classList.toggle('drop-after', !before)
            },
            ondragleave: (event) => { event.currentTarget.classList.remove('drop-before', 'drop-after') },
            ondrop: (event) => {
                const drag = ui.boardDrag
                event.currentTarget.classList.remove('drop-before', 'drop-after')
                if (!inColumn(drag)) return
                event.preventDefault()
                event.stopPropagation()
                ui.boardDrag = null
                reorderItemTo(group, drag.id, index, dropBefore(event, 'y'))
            },
        },
            h('button', {
                class: `ticket-flag${plannedRefs.has(planItemKey(item.listId, item.id)) ? ' flagged' : ''}`,
                'aria-label': plannedRefs.has(planItemKey(item.listId, item.id)) ? t('plan.inPlan') : t('plan.flag'),
                title: plannedRefs.has(planItemKey(item.listId, item.id)) ? t('plan.inPlan') : `${t('plan.flag')} (today)`,
                onclick: (event) => { event.stopPropagation(); actions.toggleItemPlan(item) },
            }, tablerIcon('flag', { size: 13 })),
            h('div', { class: `ticket-title${m.untitled ? ' untitled' : ''}`, title: m.title || t('ticket.draft.untitled') }, m.title || t('ticket.draft.untitled')),
            // A blocked ticket's reason is the most useful thing it can say,
            // and until now the field had no reader anywhere in the app.
            m.reason ? h('div', { class: 'ticket-reason label-sm', title: m.reason },
                tablerIcon('alert-triangle', { size: 13 }), h('span', {}, m.reason)) : null,
            draftCard ? h('div', { class: 'ticket-chips' }, h('span', { class: 'draft-pill' }, t('ticket.draft.badge'))) : null,
            (left.length || right.length) ? h('div', { class: 'ticket-card-meta label-sm' },
                h('div', { class: 'meta-left' }, ...left),
                h('div', { class: 'meta-right' }, ...right),
            ) : null,
            extras.length ? h('div', { class: 'ticket-extras label-sm' }, ...extras) : null,
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
        // Only carry the previous element's text across a re-render when it was
        // focused — that's the half-typed draft we must not eat. An unfocused
        // field has no uncommitted draft (blur commits), so it shows the canonical
        // value; otherwise switching tickets would inherit the prior ticket's title.
        if (prev && main.ownerDocument.activeElement === prev) {
            el.value = prev.value
            // Preserve the caret/selection across the re-render (a live-syncing
            // background render must not jump the caret to the end mid-edit).
            const selStart = prev.selectionStart, selEnd = prev.selectionEnd
            queueMicrotask(() => {
                el.focus()
                const end = el.value.length
                try { el.setSelectionRange(selStart == null ? end : selStart, selEnd == null ? end : selEnd) } catch { /* number/date inputs reject */ }
            })
        }
        return el
    }

    function renderTicketTitle(item) {
        return editableText({
            id: 'tf-title', value: item.text || '',
            placeholder: locale.i18n.t('ticket.detail.titlePlaceholder'),
            className: 'ticket-title-field',
            onCommit: (value) => {
                const text = value.trim()
                if (text && text !== item.text) actions.updateTicket(item, { text })
            },
        })
    }

    function renderTicketSummary(item, state, { full = false } = {}) {
        const t = locale.i18n.t.bind(locale.i18n)
        const b = ticketBadges(item, now())
        const chips = []
        if (b.priority) chips.push(h('span', { class: `priority-pill ${b.priority}` }, t(`ticket.priority.${b.priority}`)))
        if (b.isDone && b.timeliness) {
            const d = deltaPercent(b.inProgressHours, b.estimatedHours)
            chips.push(h('span', { class: `timeliness-badge ${b.timeliness}` }, t(`ticket.timeliness.${b.timeliness}`) + (d != null ? ` ${d > 0 ? '+' : ''}${d}%` : '')))
        } else if (b.running) {
            chips.push(h('span', { class: 'ticket-timer' }, h('span', { class: 'timer-dot' }), `${formatDuration(b.inProgressMs)}${b.estimatedHours ? ` / ${b.estimatedHours}h` : ''}`))
        }
        // No summary meta strip: estimate, complexity and time in progress are
        // all rows in the property rail two inches to the right. Saying them
        // twice on one screen is most of what made this drawer feel busy.
        //
        // The rigor task checklist is a top-level field (distinct from body
        // blocks); surface it so the done-gate stays toggleable from the detail
        // — but only once it HAS tasks. An empty "Tasks" heading over an empty
        // add bar was a second, competing place to write on every new ticket.
        const checklist = Array.isArray(item.checklist) ? item.checklist : []
        return h('div', { class: `ticket-summary${full ? ' full' : ''}` },
            chips.length ? h('div', { class: 'ticket-summary-chips' }, ...chips) : null,
            // The free-text description now lives in the block body: it is
            // folded into the first markdown block on open (foldLegacyText),
            // so the summary keeps only the structured bits.
            checklist.length ? h('div', { class: 'ticket-summary-tasks' },
                h('h3', { class: 'category-heading label-sm' }, t('ticket.detail.tasks')),
                h('div', { class: 'detail-checklist' }, ...checklist.map((task) => h('div', { class: `detail-task${task.done ? ' done' : ''}` },
                    h('label', { class: 'detail-task-main' },
                        h('input', { type: 'checkbox', checked: task.done ? '' : null, onchange: () => actions.toggleTicketTask(item, task.id) }),
                        h('span', {}, task.text),
                    ),
                    h('button', { class: 'detail-task-remove', type: 'button', 'aria-label': t('common.remove'), title: t('common.remove'), onclick: () => actions.removeTicketTask(item, task.id) }, tablerIcon('x', { size: 13 })),
                ))),
                renderTaskAddBar(item, t),
            ) : null,
        )
    }

    // Inline "add task" field for the rigor checklist. Mirrors the grocery
    // add-bar's survive-the-rerender contract: the typed draft and focus are
    // restored from the prior same-id input so a background re-render (peer
    // update, the task we just added echoing back) never eats what's half-typed.
    function renderTaskAddBar(item, t) {
        const prev = root.querySelector('#ticket-task-add')
        const input = h('input', {
            class: 'input detail-task-add',
            id: 'ticket-task-add',
            placeholder: t('ticket.detail.addTask'),
            onkeydown: (event) => {
                if (event.key === 'Escape') {
                    // Keep Escape local — the global handler would otherwise close
                    // the whole drawer mid-entry.
                    event.stopPropagation()
                    input.blur()
                    return
                }
                if (event.key !== 'Enter') return
                event.preventDefault()
                const text = input.value
                input.value = ''
                actions.addTicketTask(item, text)
            },
        })
        if (prev) {
            input.value = prev.value
            if (root.ownerDocument.activeElement === prev) queueMicrotask(() => input.focus())
        }
        return h('div', { class: 'detail-task-addrow' },
            tablerIcon('plus', { size: 14 }),
            input,
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
        const config = selectBoardConfig(listAccess(state, item.listId))
        const b = ticketBadges(item, now())
        const writers = state.roster?.writers ?? []

        const shared = h('div', { class: 'prop-shared' },
            h('h3', { class: 'category-heading label-sm' }, tablerIcon('share', { size: 13 }), h('span', {}, t('ticket.detail.sharedWith'))),
            writers.length === 0
                ? h('p', { class: 'label-sm prop-empty' }, t('ticket.detail.you'))
                : h('div', { class: 'prop-avatars' }, ...writers.map((w) => {
                    const pd = peerDisplay(w.writerKey)
                    return h('span', { class: `ticket-avatar${pd.isSelf || pd.isOwner ? ' is-self' : ''}`, title: pd.title }, pd.initials)
                })),
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
            ...writers.map((w) => h('option', { value: w.writerKey }, peerDisplay(w.writerKey).display)))
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
            propRow(tablerIcon('clock', { size: 14 }), t('ticket.detail.timeSpent'), h('span', { class: 'prop-readonly' }, formatDuration(b.inProgressMs))),
        ]
        // The blocked-reason field had a rigor RULE but no input anywhere in the
        // app, so the rule could never be satisfied and the card had nothing to
        // show. It appears only where it means something: in the blocked state.
        if ((item.status || '') === 'blocked') {
            rows.splice(1, 0, propRow(tablerIcon('alert-triangle', { size: 14 }), t('ticket.blocked.reason'),
                editableText({
                    id: 'tf-blocked-reason',
                    value: item.blockedReason || '',
                    placeholder: t('ticket.blocked.placeholder'),
                    className: 'prop-input',
                    onCommit: (value) => actions.updateTicket(item, { blockedReason: value.trim() }),
                })))
        }
        if (b.isDone && b.timeliness) {
            const d = deltaPercent(b.inProgressHours, b.estimatedHours)
            rows.push(propRow(tablerIcon('flag', { size: 14 }), t('ticket.detail.timeliness'),
                h('span', { class: `timeliness-badge ${b.timeliness}` }, t(`ticket.timeliness.${b.timeliness}`) + (d != null ? ` ${d > 0 ? '+' : ''}${d}%` : ''))))
        }
        if (item.createdBy) {
            const pd = peerDisplay(item.createdBy)
            rows.push(propRow(tablerIcon('user', { size: 14 }), t('ticket.detail.createdBy'),
                h('span', { class: 'prop-person' },
                    h('span', { class: `ticket-avatar${pd.isSelf || pd.isOwner ? ' is-self' : ''}`, title: pd.title }, pd.initials),
                    h('span', {}, pd.display))))
        }

        // Congruency box: the two planning estimates side by side (their gap is
        // what the congruency analytics measures).
        const congruencyBox = h('div', { class: 'prop-box' },
            h('h3', { class: 'category-heading label-sm' }, tablerIcon('activity', { size: 13 }), h('span', {}, t('congruency.title'))),
            h('div', { class: 'prop-pair' },
                h('label', { class: 'prop-field' }, h('span', { class: 'prop-field-label label-sm' }, t('ticket.detail.estimate')), estInput),
                h('label', { class: 'prop-field' }, h('span', { class: 'prop-field-label label-sm' }, t('ticket.detail.complexity')), cxInput),
            ),
        )

        // Value Return box: value + delay as minimalist 1-10 sliders.
        const rateSlider = (icon, labelText, current, onCommit) => {
            const readout = h('span', { class: 'rate-readout label-sm' }, current != null ? String(current) : '—')
            const slider = h('input', {
                type: 'range', min: String(VALUE_MIN), max: String(VALUE_MAX), step: '1', class: 'rate-slider',
                value: current != null ? String(current) : String(VALUE_MIN),
                oninput: (event) => { readout.textContent = event.target.value },
                onchange: (event) => onCommit(clampRate(event.target.value)),
            })
            return h('div', { class: 'rate-row' }, tablerIcon(icon, { size: 14 }), h('span', { class: 'rate-label label-sm' }, labelText), slider, readout)
        }
        const valueBox = isValueSurface(item.listId, item.listType)
            ? h('div', { class: 'prop-box' },
                h('h3', { class: 'category-heading label-sm' }, tablerIcon('coins', { size: 13 }), h('span', {}, t('value.enable'))),
                rateSlider('coins', t('value.value'), clampRate(item.valueRate), (v) => actions.updateTicket(item, { valueRate: v })),
                rateSlider('hourglass', t('value.delay'), clampRate(item.delayRate), (v) => actions.updateTicket(item, { delayRate: v })),
            )
            : null

        return h('div', { class: 'prop-rail-inner' },
            shared,
            h('div', { class: 'prop-section' },
                h('h3', { class: 'category-heading label-sm' }, t('ticket.detail.properties')),
                h('div', { class: 'prop-rows' }, ...rows),
            ),
            congruencyBox,
            valueBox,
        )
    }

    // --- block body ---------------------------------------------------------
    const SAFE_URL = /^(https?:\/\/|mailto:)/i
    const SAFE_IMG = /^(https?:\/\/|data:image\/)/i

    function blockMutedView(text, onclick) {
        return h('div', { class: 'block-md muted', onclick }, text)
    }

    function removeEmptyEditedBlock(item, block) {
        if (ui.blockEditingId !== block.id) return false
        const edited = blocksWithPendingEdit(item).find((b) => b.id === block.id)
        if (!edited || !isEmptyBlock(edited)) return false
        actions.deleteBlock(item, block.id)
        return true
    }

    function renderBlockView(item, block) {
        const t = locale.i18n.t.bind(locale.i18n)
        const edit = () => actions.startBlockEdit(item, block)
        switch (block.type) {
            case 'heading': {
                const level = block.level === 3 ? 3 : 2
                if (!(block.text || '').trim()) return blockMutedView(t('ticket.block.placeholder.heading'), edit)
                const node = h(level === 3 ? 'h3' : 'h2', { class: `block-heading block-heading-l${level}`, onclick: edit })
                node.innerHTML = renderInlineMarkdown(block.text || '')
                return node
            }
            case 'divider':
                // Non-editable structural rule; the gutter + delete still apply.
                return h('hr', { class: 'block-divider', 'aria-hidden': 'true' })
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
                return h('ul', { class: 'block-checklist' }, ...items.map((it, i) => h('li', { class: it.done ? 'done' : '', onclick: () => actions.startBlockEdit(item, block, { key: `item-${i}`, move: true }) },
                    h('input', { type: 'checkbox', checked: it.done ? '' : null, onclick: (e) => e.stopPropagation(), onchange: () => actions.toggleChecklistBlockItem(item, block.id, i) }),
                    Object.assign(h('span'), { innerHTML: renderInlineMarkdown(it.text || '') }),
                )))
            }
            case 'numberedList': {
                const items = Array.isArray(block.items) ? block.items : []
                if (!items.length) return blockMutedView(t('ticket.block.placeholder.numberedList'), edit)
                return h('ol', { class: 'block-numbered' }, ...items.map((it, i) => Object.assign(h('li', { onclick: () => actions.startBlockEdit(item, block, { key: `item-${i}`, move: true }) }), { innerHTML: renderInlineMarkdown(it.text || '') })))
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
                // Same block model (markdownToHtml) the editor seeds with, so
                // clicking into the block is visually seamless.
                const div = h('div', { class: 'block-md block-rich', onclick: edit })
                div.innerHTML = markdownToHtml(text)
                return div
            }
        }
    }

    // Slash/insert menu with type-to-filter and keyboard control. Filter and
    // selection live in-DOM (no re-render per keystroke): anchored menus focus
    // themselves and capture keys; the markdown editor drives its inline
    // instance through menu._slash.
    function renderSlashMenu(item, spec) {
        const t = locale.i18n.t.bind(locale.i18n)
        const pick = (type) => {
            // Opened by typing "/" inside a block: the slash sits on its own
            // line somewhere in the prose, so the pick splits there instead of
            // replacing the whole block and losing what is above it.
            if (spec.promote) {
                const target = blocksFor(item).find((b) => b.id === spec.blockId)
                if (target) { actions.promoteAtCaret(item, target, type, spec.split ? spec.split() : null); return }
            }
            if (spec.mode === 'replace') actions.replaceBlock(item, spec.blockId, type)
            else actions.insertBlock(item, type, spec.mode === 'after' ? spec.blockId : null)
        }
        const headLabel = spec.mode === 'replace' ? t('ticket.block.turnInto') : t('ticket.block.insert')
        const head = h('div', { class: 'slash-head label-sm' })
        const entries = BLOCK_TYPES.map((bt) => ({
            type: bt.type,
            label: t(bt.labelKey),
            el: h('button', {
                class: 'slash-item',
                type: 'button',
                role: 'menuitem',
                onmousedown: (event) => event.preventDefault(),
                onclick: () => pick(bt.type),
            }, tablerIcon(bt.icon, { size: 15 }), h('span', { class: 'label-md' }, t(bt.labelKey))),
        }))
        let filter = ''
        let sel = 0
        let visible = entries
        const apply = () => {
            const q = filter.toLowerCase()
            visible = entries.filter((entry) => entry.label.toLowerCase().includes(q))
            if (sel >= visible.length) sel = Math.max(0, visible.length - 1)
            for (const entry of entries) {
                entry.el.style.display = visible.includes(entry) ? '' : 'none'
                entry.el.classList.toggle('sel', visible[sel] === entry)
            }
            head.textContent = filter ? `${headLabel} · ${filter}` : headLabel
            visible[sel]?.el.scrollIntoView({ block: 'nearest' })
        }
        const menu = h('div', { class: 'block-slash-menu', role: 'menu', tabindex: '-1' },
            head,
            ...entries.map((entry) => entry.el),
            h('div', { class: 'slash-foot label-sm' }, '↑↓ · ↵ · esc'),
        )
        menu._slash = {
            filterTo(q) { filter = q; sel = 0; apply() },
            move(delta) { if (visible.length) { sel = (sel + delta + visible.length) % visible.length; apply() } },
            choose() { const hit = visible[sel]; if (hit) pick(hit.type); return !!hit },
        }
        menu.addEventListener('keydown', (event) => {
            // Anchored mode: the focused menu owns the keyboard, so single-key
            // app shortcuts (i, t, n, …) never fire underneath it.
            event.stopPropagation()
            if (event.key === 'Escape') { actions.closeBlockMenu(); return }
            if (event.key === 'ArrowDown') { event.preventDefault(); menu._slash.move(1); return }
            if (event.key === 'ArrowUp') { event.preventDefault(); menu._slash.move(-1); return }
            if (event.key === 'Enter') { event.preventDefault(); menu._slash.choose(); return }
            if (event.key === 'Backspace') { menu._slash.filterTo(filter.slice(0, -1)); return }
            if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) menu._slash.filterTo(filter + event.key)
        })
        apply()
        return menu
    }

    // Seed a callout's contentEditable with inline-only HTML (no heading
    // parsing — the callout view renders inline markdown only).
    function inlineBlockToHtml(text) {
        const lines = String(text == null ? '' : text).split('\n')
        return lines.map((line) => `<p>${inlineMarkdownToHtml(line)}</p>`).join('') || '<p></p>'
    }

    // WYSIWYG editor for markdown + callout blocks: a contentEditable that is
    // seeded with compiled markdown and re-serialized to markdown on every input
    // via htmlToMarkdown, so the stored value stays markdown while the user only
    // ever sees the rendered result. Markdown blocks also get block-level
    // heading rules and the inline "/" command menu.
    function renderRichBlockEditor(item, block) {
        const t = locale.i18n.t.bind(locale.i18n)
        const isMarkdown = block.type === 'markdown'
        const placeholder = t(`ticket.block.placeholder.${block.type}`)
        const slashSpec = { mode: 'replace', blockId: block.id, promote: true }
        const menu = isMarkdown ? renderSlashMenu(item, slashSpec) : null
        // The inline menu opens while the CARET'S LINE is "/" plus an optional
        // filter word ("/tab" → Table), and Esc only dismisses the menu, not
        // the edit. It used to test the whole draft, so "/" was dead in any
        // block that already had a word in it — while two hints advertised it.
        let slashDismissed = false

        // The caret's own paragraph element, which is what "the line" means in
        // a rich editor. Everything that has to know where the line starts asks
        // the DOM, never the draft string.
        const caretParagraph = () => {
            const sel = window.getSelection()
            if (!sel || sel.rangeCount === 0) return null
            let node = sel.getRangeAt(0).startContainer
            if (!ed.contains(node)) return null
            if (node.nodeType === 3) node = node.parentNode
            while (node && node.parentNode && node.parentNode !== ed) node = node.parentNode
            return node && node.parentNode === ed ? node : null
        }
        const caretLine = () => (caretParagraph()?.textContent || '').split(ZWSP).join('')
        // What stays behind and what rides along when the caret's line is
        // promoted to a block of its own. The line itself is consumed.
        const splitAroundCaretLine = () => {
            const para = caretParagraph()
            const kids = [...ed.children]
            const at = para ? kids.indexOf(para) : -1
            if (at < 0) return { before: htmlToMarkdown(ed.innerHTML).trim(), after: '' }
            return {
                before: htmlToMarkdown(kids.slice(0, at).map((k) => k.outerHTML).join('')).trim(),
                after: htmlToMarkdown(kids.slice(at + 1).map((k) => k.outerHTML).join('')).trim(),
            }
        }
        slashSpec.split = splitAroundCaretLine

        const slashActive = () => !slashDismissed && slashQuery(caretLine()) !== null
        const syncSlashMenu = () => {
            if (!menu) return
            const query = slashQuery(caretLine())
            if (query === null) slashDismissed = false
            const on = !slashDismissed && query !== null
            menu.classList.toggle('hidden', !on)
            menu.classList.toggle('open', on)
            if (on) menu._slash.filterTo(query)
        }
        if (menu) menu.classList.add('block-slash-inline')

        const ed = h('div', {
            id: `block-${block.id}-text`,
            class: `block-md block-rich block-editor block-rich-${block.type}${block.type === 'heading' ? ` block-heading-l${block.level === 3 ? 3 : 2}` : ''}`,
            contenteditable: 'true',
            role: 'textbox',
            'aria-multiline': 'true',
            'aria-label': placeholder,
            'data-placeholder': placeholder,
            spellcheck: 'true',
        })
        ed.innerHTML = isMarkdown ? markdownToHtml(ui.blockDraft) : inlineBlockToHtml(ui.blockDraft)
        seedRichCaretAnchors(ed)
        ed.classList.toggle('is-empty', ui.blockDraft === '')
        // Only now: the caret helpers above read the editor's own DOM, so they
        // cannot run until `ed` exists.
        syncSlashMenu()

        // Remember the caret across re-renders (the app rebuilds this editor on
        // every P2P/local store update); null means "place at end" on next build.
        const remember = () => { ui.blockCaret = richCaretOffset(ed) }
        const sync = () => {
            ui.blockDraft = htmlToMarkdown(ed.innerHTML)
            ed.classList.toggle('is-empty', ui.blockDraft === '')
            remember()
            syncSlashMenu()
        }
        ed.addEventListener('input', (event) => {
            if (event.isComposing) return
            // Live-interpret recognized markdown so the raw syntax never lingers.
            if (isMarkdown && applyHeadingInputRule(ed)) { sync(); return }
            applyInlineInputRules()
            sync()
            if (removeEmptyEditedBlock(item, block)) return
            // "- ", "1. ", "> ", "```", "---" on their own line become the block
            // they describe. Typing the structure IS choosing it, so the menu
            // is left to the shapes no shorthand can spell.
            if (!isMarkdown) return
            const line = caretLine()
            const shorthand = blockShorthand(line)
            if (shorthand) actions.promoteAtCaret(item, block, shorthand, splitAroundCaretLine())
        })
        ed.addEventListener('keyup', remember)
        ed.addEventListener('mouseup', remember)
        ed.addEventListener('keydown', (event) => {
            if (menu && slashActive()) {
                // While the inline menu is open the keyboard drives it.
                if (event.key === 'ArrowDown') { event.preventDefault(); menu._slash.move(1); return }
                if (event.key === 'ArrowUp') { event.preventDefault(); menu._slash.move(-1); return }
                if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey && !event.shiftKey) { event.preventDefault(); menu._slash.choose(); return }
                if (event.key === 'Escape') { event.stopPropagation(); slashDismissed = true; syncSlashMenu(); return }
            }
            if (event.isComposing) return
            if (event.key === 'Escape') { event.stopPropagation(); actions.cancelBlockEdit(); return }
            if (block.type === 'heading' && event.key === 'Enter') { event.preventDefault(); actions.commitBlockEdit(item); return }
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); actions.commitBlockEdit(item); return }
            if ((event.metaKey || event.ctrlKey) && !event.altKey) {
                const k = event.key.toLowerCase()
                if (k === 'b') { event.preventDefault(); document.execCommand('bold'); sync() }
                else if (k === 'i') { event.preventDefault(); document.execCommand('italic'); sync() }
            }
        })
        // Paste as plain text: keeps the document to the whitelisted subset and
        // lets pasted "**md**" flow through the same input rules on next edit.
        ed.addEventListener('paste', (event) => {
            event.preventDefault()
            const text = (event.clipboardData || window.clipboardData)?.getData('text/plain') || ''
            document.execCommand('insertText', false, text)
        })
        ed.addEventListener('blur', () => queueMicrotask(() => {
            // A shorthand replaces this editor with another block type. The
            // detached prose editor must not commit/delete the new empty list.
            if (!ed.isConnected) return
            const live = root.querySelector('.block-editor')
            if (live && live !== ed && main.ownerDocument.activeElement === live) return
            if (ui.blockEditingId === block.id) actions.commitBlockEdit(item)
        }))

        queueMicrotask(() => {
            if (!ed.isConnected || (main.ownerDocument.activeElement === ed && ui.blockCaret != null)) return
            try { document.execCommand('styleWithCSS', false, false) } catch { /* not supported */ }
            try { document.execCommand('defaultParagraphSeparator', false, 'p') } catch { /* not supported */ }
            ed.focus()
            // Restore the remembered caret, else place it at the very end.
            if (ui.blockCaret != null && setRichCaretOffset(ed, ui.blockCaret)) return
            try {
                const r = document.createRange()
                r.selectNodeContents(ed)
                r.collapse(false)
                const sel = window.getSelection()
                sel.removeAllRanges()
                sel.addRange(r)
                // The write acknowledgement may rebuild this field before the
                // next key. Preserve the initial end position, too.
                remember()
            } catch { /* ignore */ }
        })
        return h('div', { class: 'block-editor-wrap' }, ed, menu)
    }

    // Headings remain formatted while editing, with a separate level control.
    function renderHeadingEditor(item, block) {
        const level = block.level === 3 ? 3 : 2
        const editor = renderRichBlockEditor(item, block)
        const levelToggle = h('div', { class: 'segmented heading-level' },
            ...[2, 3].map((lv) => h('button', {
                class: `seg ${level === lv ? 'active' : ''}`,
                type: 'button',
                // mousedown would blur the input and commit before the click lands.
                onmousedown: (event) => event.preventDefault(),
                onclick: () => actions.setBlockLevel(item, block.id, lv),
            }, `H${lv}`)),
        )
        return h('div', { class: 'block-heading-wrap' }, editor, levelToggle)
    }

    // Grid editor for table blocks: a table edits AS a table — one <input> per
    // cell (row 0 = header) with per-row/column delete and add-row/column
    // affordances — instead of the comma-separated textarea. The grid lives in
    // ui.blockTableDraft and is folded back onto block.rows by
    // blocksWithPendingEdit, so a cell may safely contain a comma (the old text
    // channel split cells on commas). Tab / click move between cells; Enter drops
    // to the cell below; ⌘/Ctrl+Enter saves; Escape cancels.
    function renderTableBlockEditor(item, block) {
        const t = locale.i18n.t.bind(locale.i18n)
        if (!Array.isArray(ui.blockTableDraft)) seedBlockDraft(block)
        const grid = ui.blockTableDraft
        const cols = grid[0].length

        const wrap = h('div', { class: 'block-editor-wrap block-table-editor' })

        // Commit only when focus truly leaves the whole grid. Moving between
        // cells / clicking a toolbar button keeps focus inside .block-table-editor
        // (the live one after a structural re-render), so it must not commit.
        const guardedBlur = (event) => {
            if (wrap.contains(event.relatedTarget)) return
            queueMicrotask(() => {
                const live = root.querySelector('.block-table-editor')
                if (live && live.contains(main.ownerDocument.activeElement)) return
                if (ui.blockEditingId === block.id) actions.commitBlockEdit(item)
            })
        }

        // Structural change (add/remove row or column): rebuild and land focus on
        // the intended cell. onmousedown:preventDefault on the buttons keeps the
        // focused cell from blurring first, so guardedBlur never fires here.
        const applyTable = (nextRows, focus) => {
            ui.blockTableDraft = normalizeTableRows(nextRows)
            ui.blockTableFocus = focus
            renderAll()
        }

        // After removing a row/column, keep the caret on the cell it was in
        // (shifting its index when the removed line was at or before it) instead
        // of yanking it to the header row / first column.
        const focusAfterRemoveRow = (removed) => {
            const f = ui.blockTableFocus || { r: 0, c: 0 }
            const r = f.r === removed ? Math.min(removed, grid.length - 2) : (f.r > removed ? f.r - 1 : f.r)
            return { r: Math.max(0, r), c: f.c, offset: f.offset }
        }
        const focusAfterRemoveCol = (removed) => {
            const f = ui.blockTableFocus || { r: 0, c: 0 }
            const c = f.c === removed ? Math.min(removed, cols - 2) : (f.c > removed ? f.c - 1 : f.c)
            return { r: f.r, c: Math.max(0, c), offset: f.offset }
        }

        const cellInput = (r, c) => {
            const input = h('input', {
                class: `block-table-cell${r === 0 ? ' block-table-head' : ''}`,
                type: 'text',
                value: grid[r][c] || '',
                'aria-label': t('ticket.block.table.cellLabel'),
                dataset: { cell: `${r},${c}` },
                oninput: (event) => {
                    grid[r][c] = event.target.value
                    ui.blockTableFocus = { r, c, offset: event.target.selectionStart }
                    if (!event.isComposing) removeEmptyEditedBlock(item, block)
                },
                onfocus: (event) => { ui.blockTableFocus = { r, c, offset: event.target.selectionStart } },
                onkeyup: (event) => { ui.blockTableFocus = { r, c, offset: event.target.selectionStart } },
                onkeydown: (event) => {
                    if (event.key === 'Escape') { event.stopPropagation(); actions.cancelBlockEdit(); return }
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); actions.commitBlockEdit(item); return }
                    if (event.key === 'Enter') {
                        event.preventDefault()
                        const below = wrap.querySelector(`[data-cell="${r + 1},${c}"]`)
                        if (below) { ui.blockTableFocus = { r: r + 1, c }; below.focus() }
                        else actions.commitBlockEdit(item)
                    }
                },
                onblur: guardedBlur,
            })
            return input
        }

        const iconBtn = (icon, labelKey, onclick) => h('button', {
            class: 'block-table-btn',
            type: 'button',
            'aria-label': t(labelKey),
            title: t(labelKey),
            onmousedown: (event) => event.preventDefault(),
            onclick,
        }, tablerIcon(icon, { size: 14 }))

        // Grid: a leading control column (per-row delete) + a leading control row
        // (per-column delete), then the cell inputs. Children are laid out in
        // row-major order to match grid-template-columns.
        const children = []
        // Control row: corner + one delete-column button per column.
        children.push(h('span', { class: 'block-table-corner' }))
        for (let c = 0; c < cols; c++) {
            children.push(cols > 1
                ? iconBtn('trash', 'ticket.block.table.deleteColumn', () => applyTable(tableRemoveColumn(grid, c), focusAfterRemoveCol(c)))
                : h('span', { class: 'block-table-corner' }))
        }
        // One row per data row: delete-row button + the cell inputs.
        grid.forEach((row, r) => {
            children.push(grid.length > 1
                ? iconBtn('trash', 'ticket.block.table.deleteRow', () => applyTable(tableRemoveRow(grid, r), focusAfterRemoveRow(r)))
                : h('span', { class: 'block-table-corner' }))
            for (let c = 0; c < cols; c++) children.push(cellInput(r, c))
        })

        const gridEl = h('div', {
            class: 'block-table-grid',
            style: `grid-template-columns: auto repeat(${cols}, minmax(72px, 1fr));`,
        }, ...children)

        const toolbar = h('div', { class: 'block-table-toolbar' },
            h('button', {
                class: 'block-table-add', type: 'button',
                onmousedown: (event) => event.preventDefault(),
                onclick: () => applyTable(tableAddRow(grid), { r: grid.length, c: 0 }),
            }, tablerIcon('plus', { size: 13 }), h('span', {}, t('ticket.block.table.addRow'))),
            h('button', {
                class: 'block-table-add', type: 'button',
                onmousedown: (event) => event.preventDefault(),
                onclick: () => applyTable(tableAddColumn(grid), { r: 0, c: cols }),
            }, tablerIcon('plus', { size: 13 }), h('span', {}, t('ticket.block.table.addColumn'))),
            h('span', { class: 'block-table-hint label-sm' }, t('ticket.block.table.hint')),
        )

        // Restore focus after a (structural) re-render. If focus already sits in
        // the grid, leave it — an unrelated re-render must not steal the caret.
        queueMicrotask(() => {
            if (wrap.contains(main.ownerDocument.activeElement)) return
            const f = ui.blockTableFocus
            const target = (f && wrap.querySelector(`[data-cell="${f.r},${f.c}"]`)) || wrap.querySelector('.block-table-cell')
            if (!target) return
            target.focus()
            const off = (f && Number.isInteger(f.offset)) ? Math.min(f.offset, target.value.length) : target.value.length
            try { target.setSelectionRange(off, off) } catch { /* ignore */ }
        })

        wrap.append(gridEl, toolbar)
        return wrap
    }

    function renderBlockEditor(item, block) {
        if (block.type === 'markdown' || block.type === 'callout') return renderRichBlockEditor(item, block)
        if (block.type === 'heading') return renderHeadingEditor(item, block)
        if (block.type === 'divider') return h('hr', { class: 'block-divider', 'aria-hidden': 'true' })
        if (block.type === 'table') return renderTableBlockEditor(item, block)
        if (['checklist', 'numberedList', 'links', 'image'].includes(block.type)) {
            if (ui.blockStructuredDraft?.id !== block.id) seedBlockDraft(block)
            return renderStructuredBlockEditor({
                block, draft: ui.blockStructuredDraft, focus: ui.blockFieldFocus,
                setFocus: (focus) => { ui.blockFieldFocus = focus; ui.blockCaret = focus.offset },
                changed: () => removeEmptyEditedBlock(item, block), redraw: renderAll,
                commit: () => { if (ui.blockEditingId === block.id) actions.commitBlockEdit(item) },
                cancel: () => actions.cancelBlockEdit(),
                exitList: () => actions.finishBlockAndContinue(item, block.id),
                t: locale.i18n.t.bind(locale.i18n),
                rich: { offset: richCaretOffset, setOffset: setRichCaretOffset, seed: seedRichCaretAnchors, inlineRules: applyInlineInputRules },
            })
        }
        // A code block edits as code; no fences or serialization syntax.
        const ta = h('textarea', {
            id: `block-${block.id}-code`, class: 'block-editor block-code', rows: '4',
            'aria-label': locale.i18n.t('ticket.block.placeholder.code'),
            oninput: (event) => {
                ui.blockDraft = event.target.value
                ui.blockCaret = event.target.selectionStart
                if (!event.isComposing) removeEmptyEditedBlock(item, block)
            },
            onkeydown: (event) => {
                if (event.key === 'Escape') { event.stopPropagation(); actions.cancelBlockEdit(); return }
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); actions.commitBlockEdit(item) }
            },
            onblur: () => queueMicrotask(() => {
                if (document.activeElement?.id === ta.id) return
                if (ui.blockEditingId === block.id) actions.commitBlockEdit(item)
            }),
        })
        ta.value = ui.blockDraft
        queueMicrotask(() => {
            if (!ta.isConnected || document.activeElement === ta) return
            ta.focus()
            const at = ui.blockCaret ?? ta.value.length
            ta.setSelectionRange(at, at)
        })
        return h('div', { class: 'block-editor-wrap' }, ta)
    }

    // Options menu behind the six-dot handle: turn into, insert below, delete.
    // Turn-into and insert re-anchor the slash menu in the matching mode.
    function renderBlockOpsMenu(item, block) {
        const t = locale.i18n.t.bind(locale.i18n)
        const op = (icon, label, onclick) => h('button', {
            class: 'slash-item',
            type: 'button',
            role: 'menuitem',
            onmousedown: (event) => event.preventDefault(),
            onclick,
        }, tablerIcon(icon, { size: 15 }), h('span', { class: 'label-md' }, label))
        const menu = h('div', { class: 'block-slash-menu', role: 'menu', tabindex: '-1' },
            block.type === 'divider' ? null : op('pencil', t('ticket.block.edit'), () => actions.startBlockEdit(item, block)),
            op('switch-horizontal', t('ticket.block.turnInto'), () => actions.openBlockMenu({ mode: 'turn', blockId: block.id })),
            op('plus', t('ticket.block.insert'), () => actions.openBlockMenu({ mode: 'after', blockId: block.id })),
            op('trash', t('ticket.block.delete'), () => actions.deleteBlock(item, block.id)),
        )
        menu.addEventListener('keydown', (event) => {
            event.stopPropagation()
            if (event.key === 'Escape') actions.closeBlockMenu()
        })
        return menu
    }

    function renderBlock(item, block) {
        const t = locale.i18n.t.bind(locale.i18n)
        const editing = ui.blockEditingId === block.id
        const anchoredMenu = () => {
            if (editing || !ui.blockMenu || ui.blockMenu.blockId !== block.id) return null
            const menu = ui.blockMenu.mode === 'ops' ? renderBlockOpsMenu(item, block)
                : ui.blockMenu.mode === 'turn' ? renderSlashMenu(item, { mode: 'replace', blockId: block.id })
                    : ui.blockMenu.mode === 'after' ? renderSlashMenu(item, ui.blockMenu)
                        : null
            if (!menu) return null
            // Focus the menu so type-to-filter and ↑↓/↵/esc work immediately.
            queueMicrotask(() => { if (menu.isConnected) menu.focus() })
            return h('div', { class: 'block-menu-anchor' }, h('div', { class: 'block-menu-scrim', onclick: () => actions.closeBlockMenu() }), menu)
        }
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
            // Floating six-dot handle: hover-only, absolutely positioned into
            // the container padding so it never indents the content. Click
            // opens the options menu; drag reorders. Hidden while editing.
            editing ? null : h('button', {
                class: 'block-handle',
                type: 'button',
                draggable: 'true',
                'aria-label': t('ticket.block.options'),
                title: t('ticket.block.options'),
                onclick: () => actions.openBlockMenu({ mode: 'ops', blockId: block.id }),
                ondragstart: (event) => {
                    ui.blockDrag = { id: block.id }
                    event.dataTransfer.effectAllowed = 'move'
                    try { event.dataTransfer.setData('text/plain', block.id) } catch { /* some platforms reject */ }
                    row.classList.add('block-dragging')
                },
                ondragend: () => { ui.blockDrag = null; row.classList.remove('block-dragging') },
            }, tablerIcon('grip-vertical', { size: 14 })),
            h('div', { class: 'block-content' }, editing ? renderBlockEditor(item, block) : renderBlockView(item, block)),
            anchoredMenu(),
        )
        return row
    }

    // The trailing composer: an always-present empty line at the end of the
    // body. It owns no state — the first keystroke hands its text to a real
    // block and the block editor takes over — so nothing uncommitted ever
    // lives in it, and merely opening a ticket writes nothing.
    function renderComposer(item) {
        const t = locale.i18n.t.bind(locale.i18n)
        const placeholder = t('ticket.block.composer')
        const el = h('div', {
            id: 'ticket-composer',
            class: 'block-composer block-md block-rich',
            contenteditable: 'true',
            role: 'textbox',
            'aria-label': placeholder,
            'data-placeholder': placeholder,
            spellcheck: 'true',
            oninput: () => {
                const text = (el.textContent || '').replace(/​/g, '')
                if (!text) return
                el.textContent = ''
                // Hand the keyboard over before the block exists. The rebuild
                // that follows restores focus to whatever was focused when it
                // started — which, without this, is the composer, so the new
                // block's editor would lose the race for every keystroke.
                el.blur()
                // "/" still opens the menu, for the shapes no shorthand spells.
                if (text === '/') { actions.openBlockMenu({ mode: 'end' }); return }
                const shorthand = blockShorthand(text, text.length)
                if (shorthand) { actions.insertBlock(item, shorthand); return }
                actions.insertBlock(item, 'markdown', null, text)
            },
            onkeydown: (event) => {
                if (event.key === 'Escape') { event.stopPropagation(); el.blur() }
            },
        })
        return el
    }

    function renderTicketBody(item, { legacyField = 'description', variant = 'drawer' } = {}) {
        const t = locale.i18n.t.bind(locale.i18n)
        const blocks = blocksFor(item)
        const addMenuOpen = !!(ui.blockMenu && ui.blockMenu.mode === 'end')
        // Legacy free-text not yet folded into blocks (fold echo pending, or
        // this peer isn't writable yet): keep it visible read-only so removing
        // the old field's UI never hides data.
        const legacy = typeof item[legacyField] === 'string' ? item[legacyField].trim() : ''
        let legacyRow = null
        if (legacy) {
            const md = h('div', { class: 'block-md block-rich' })
            md.innerHTML = markdownToHtml(legacy)
            legacyRow = h('div', { class: 'block' }, h('div', { class: 'block-content' }, md))
        }
        let endMenu = null
        if (addMenuOpen) {
            const menu = renderSlashMenu(item, { mode: 'end' })
            queueMicrotask(() => { if (menu.isConnected) menu.focus() })
            endMenu = h('div', { class: 'block-menu-anchor end' }, h('div', { class: 'block-menu-scrim', onclick: () => actions.closeBlockMenu() }), menu)
        }
        if (variant === 'inspector') {
            // The body is always open for writing. A composer sits at the end —
            // focused when the drawer opens — and the first keystroke hands its
            // text to a real block. There is no empty state to click through
            // and no "+ Add block": the cursor IS the empty state, and the
            // shorthands ("- ", "1. ", "> ") are the menu.
            //
            // A click on the body's dead space puts the caret in the composer
            // rather than manufacturing a block, so looking at a ticket never
            // writes to it.
            return h('section', {
                class: 'ticket-body inspector-variant',
                onclick: (event) => {
                    const el = event.target
                    if (ui.blockEditingId) return
                    if (el === event.currentTarget || (el instanceof HTMLElement && el.classList.contains('ticket-blocks'))) {
                        root.querySelector('#ticket-composer')?.focus()
                    }
                },
            },
                legacyRow,
                blocks.length ? h('div', { class: 'ticket-blocks' }, ...blocks.map((b) => renderBlock(item, b))) : null,
                h('div', { class: 'block-add-row' },
                    // ALWAYS rendered, even while a block is being edited.
                    // createSurfaceDomState restores focus positionally with a
                    // signature check, so a field that comes and goes changes
                    // the field list's shape between renders and the restore
                    // lands on the wrong element — which, mid-typing, means the
                    // next keystroke goes somewhere the writer did not look.
                    renderComposer(item),
                    endMenu,
                ),
            )
        }
        return h('section', { class: 'ticket-body' },
            h('div', { class: 'ticket-body-head' },
                h('h3', { class: 'category-heading label-sm' }, t('ticket.detail.body')),
                blocks.length ? h('span', { class: 'block-hint label-sm' }, `${t('ticket.block.editHint')} · ${t('ticket.block.slashHint')}`) : null,
            ),
            legacyRow,
            blocks.length === 0
                ? (legacy ? null : h('button', { class: 'block-empty', type: 'button', onclick: () => actions.openBlockMenu({ mode: 'end' }) }, tablerIcon('plus', { size: 16 }), t('ticket.block.empty')))
                : h('div', { class: 'ticket-blocks' }, ...blocks.map((b) => renderBlock(item, b))),
            h('div', { class: 'block-add-row' },
                h('button', { class: 'block-add', type: 'button', onclick: () => actions.openBlockMenu({ mode: 'end' }) }, tablerIcon('plus', { size: 14 }), t('ticket.block.add')),
                endMenu,
            ),
        )
    }

    function renderTicketDrawer(item, state) {
        const t = locale.i18n.t.bind(locale.i18n)
        const drawer = h('aside', { class: 'detail-drawer' },
            h('div', { class: 'detail-toolbar' },
                renderTicketTitle(item),
                h('div', { class: 'detail-toolbar-actions' },
                    h('button', { class: 'btn btn-secondary btn-icon', type: 'button', 'aria-label': t('ticket.detail.openFull'), title: t('ticket.detail.openFull'), onclick: () => actions.promoteTicket(item.id) }, tablerIcon('arrows-maximize', { size: 15 })),
                    h('button', { class: 'btn btn-secondary btn-icon', type: 'button', 'aria-label': t('main.item.move'), title: t('main.item.move'), onclick: () => openDialog({ kind: 'item-move', item }) }, tablerIcon('switch-horizontal', { size: 15 })),
                    h('button', { class: 'btn btn-secondary btn-icon', type: 'button', 'aria-label': t('ticket.detail.close'), title: t('ticket.detail.close'), onclick: () => actions.closeTicket() }, tablerIcon('x', { size: 16 })),
                ),
            ),
            // Tasks and body occupy the writing column on the left, with the
            // property rail on the right, as in the full view.
            // DOM order summary→body→rail so the narrow-window fallback stacks
            // with the prominent content first; the grid places by area.
            h('div', { class: 'detail-split-scroll two-col' },
                renderTicketSummary(item, state, { full: false }),
                renderTicketBody(item, { variant: 'inspector' }),
                h('div', { class: 'prop-rail compact' }, renderPropertyRail(item, state)),
            ),
        )
        if (drawerWidths.ticket) drawer.style.width = `${drawerWidths.ticket}px`
        drawer.append(drawerResizer(drawer, 'ticket', 'listam.ticketW', 600))
        return drawer
    }

    // Non-modal right-side Inspector for a grocery/todo item (toggle I). Reuses
    // the drawer slide-in but narrower; the list stays clickable. Free-form
    // detail is the shared block body (same system as board tickets); legacy
    // `note` text folds into the first markdown block via foldLegacyText.
    function renderItemInspector(item, state) {
        const t = locale.i18n.t.bind(locale.i18n)
        const isGrocery = !isBoardType(item.listType) && !isTodoType(item.listType)
        let categoryName = ''
        if (isGrocery) {
            const sections = groupByCategory([item], locale.i18n.groceryLocale)
            const key = sections[0] && sections[0].canonicalKey
            if (key) categoryName = getDisplayCategoryName(key, locale.i18n.groceryLocale)
        }
        const quantityInput = h('input', { class: 'input', value: item.quantity || '', placeholder: t('inspector.quantityPlaceholder') })
        quantityInput.addEventListener('change', () => {
            const v = quantityInput.value.trim()
            if (v !== (item.quantity || '')) actions.setItemFields(item, { quantity: v })
        })
        const sectionBlock = (labelKey, ...children) => h('div', { class: 'inspector-section' },
            h('h3', { class: 'category-heading label-sm' }, t(labelKey)), ...children)
        const bs = beaconState(state)
        const aside = h('aside', { class: 'item-inspector' },
            h('div', { class: 'inspector-head' },
                h('div', { class: 'inspector-kicker-row' },
                    h('span', { class: 'inspector-kicker label-sm' }, `${t('inspector.kicker')} · ${isGrocery ? t('desktop.rail.groceries') : t('desktop.rail.todo')}`),
                    h('button', { class: 'btn btn-secondary btn-icon', type: 'button', 'aria-label': t('ticket.detail.close'), title: t('ticket.detail.close'), onclick: () => actions.closeInspector() }, tablerIcon('x', { size: 16 })),
                ),
                editableText({
                    id: 'insp-title',
                    value: item.text || '',
                    placeholder: t('main.item.editPlaceholder'),
                    className: 'inspector-title-field title-lg',
                    onCommit: (v) => actions.editItem(item, v),
                }),
            ),
            h('div', { class: 'inspector-body' },
                isGrocery ? sectionBlock('inspector.quantity', quantityInput) : null,
                isValueItem(item)
                    ? sectionBlock('inspector.value',
                        h('div', { class: 'inspector-value' },
                            hasValueRating(item) ? h('div', { class: 'value-badges' }, ...valueBadges(item)) : null,
                            h('button', { class: 'btn btn-secondary', onclick: () => openDialog({ kind: 'value-rate', mode: 'edit', item, valueRate: clampRate(item.valueRate), delayRate: clampRate(item.delayRate) }) }, t('inspector.value')),
                        ))
                    : null,
                isGrocery && categoryName ? sectionBlock('inspector.category', h('span', { class: 'category-pill label-sm' }, categoryName)) : null,
                renderTicketBody(item, { legacyField: 'note', variant: 'inspector' }),
            ),
            // Mockup footer: edited-time on the left, live sync beacon on the
            // right (replaces the old STATUS section at the top).
            h('div', { class: 'inspector-foot label-sm' },
                h('span', {}, item.updatedAt > 1e12 ? t('inspector.edited', { time: relativeTime(now() - item.updatedAt) }) : ''),
                h('span', { class: 'inspector-foot-status' },
                    h('span', { class: `dot ${bs}` }),
                    h('span', {}, t(connectionStatusKey(state, 'header.status.online'), { count: state.peerCount })),
                ),
            ),
        )
        if (drawerWidths.insp) aside.style.width = `${drawerWidths.insp}px`
        aside.append(drawerResizer(aside, 'insp', 'listam.inspectorW', 320))
        return aside
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
                renderTicketTitle(item),
                h('button', { class: 'btn btn-secondary', type: 'button', onclick: () => actions.collapseTicket() }, tablerIcon('arrows-minimize', { size: 15 }), t('ticket.detail.exitFull')),
                h('div', { class: 'header-actions' },
                    h('button', { class: 'btn btn-secondary btn-icon', type: 'button', 'aria-label': t('ticket.detail.close'), title: t('ticket.detail.close'), onclick: () => actions.closeTicket() }, tablerIcon('x', { size: 16 })),
                ),
            ),
            h('div', { class: 'ticket-doc' },
                h('div', { class: 'ticket-doc-summary' }, renderTicketSummary(item, state, { full: true })),
                h('aside', { class: 'ticket-doc-rail prop-rail' }, renderPropertyRail(item, state)),
                h('div', { class: 'ticket-doc-body' }, renderTicketBody(item, { variant: 'inspector' })),
            ),
        )
    }

    // Congruency analytics as its own pane, sitting directly under Peers &
    // Devices in the sidebar. It lived in Settings → Analytics for a while, and
    // that was the wrong shape: this is something you go and READ, and inside a
    // scrolling dialog it was both buried and cramped.
    function renderAnalyticsPane(state) {
        const t = locale.i18n.t.bind(locale.i18n)
        replaceChildren(main,
            h('header', { class: 'page-header' },
                h('h1', { class: 'page-title title-lg' }, t('desktop.analytics.title')),
            ),
            h('section', { class: 'pane-section' },
                h('h3', { class: 'category-heading label-sm' }, t('congruency.title')),
                ...congruencyContent(state),
            ),
        )
    }

    // The pane's body, kept split out so it can be built without a pane around it.
    function congruencyContent(state) {
        const t = locale.i18n.t.bind(locale.i18n)
        requestBoardConfigOnce()
        const stats = selectWriterStats(state.items)
        const legend = (cls, label) => h('span', { class: 'lg' }, h('span', { class: `sw ${cls}` }), label)
        return [
            h('p', { class: 'body-md analytics-note' }, t('congruency.subtitle')),
            stats.length === 0
                ? h('p', { class: 'body-md analytics-note' }, t('congruency.empty'))
                : h('div', { class: 'congruency-cards' }, ...stats.map(renderCongruencyCard)),
            stats.length
                ? h('div', { class: 'congruency-legend label-sm' },
                    legend('on-time', t('congruency.legend.onTime')),
                    legend('over', t('congruency.legend.overtime')),
                    legend('under', t('congruency.legend.undertime')))
                : null,
        ]
    }

    function renderCongruencyCard(stat) {
        const t = locale.i18n.t.bind(locale.i18n)
        const total = Math.max(1, stat.count)
        const pd = stat.user === 'unassigned' ? null : peerDisplay(stat.user)
        const name = pd ? pd.display : '—'
        return h('div', { class: 'congruency-card' },
            h('div', { class: 'congruency-user' },
                h('span', { class: `ticket-avatar${pd && (pd.isSelf || pd.isOwner) ? ' is-self' : ''}`, title: pd ? pd.title : '' }, pd ? pd.initials : '—'),
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

    // One invite rendering for both the Peers pane and the share dialog. Before
    // this, both sites bound `state.inviteKey` raw: the code and its QR swapped
    // under the sharer the moment anything re-minted, with no countdown, no sign
    // the code works exactly once, and no way to tell an expired code from a live
    // one. All three facts ride the invite envelope; this is where they surface.
    function renderInviteBlock(state, { showCopy = true, emptyKey = 'desktop.peers.invite.none', emptyClass = 'body-md pane-note' } = {}) {
        const t = locale.i18n.t.bind(locale.i18n)
        const invite = describeInvite({ key: state.inviteKey, ...(state.invite ?? {}) }, now())
        if (!invite.code) return h('p', { class: emptyClass }, t(emptyKey))
        const regenerate = h('button', {
            class: 'btn btn-secondary',
            onclick: () => actions.regenerateInvite(),
        }, t('invite.batch.generate'))
        // Rendering a QR for a dead code invites a second failed join. Say it is
        // expired and offer the one action that helps.
        if (invite.expired) {
            return h('div', { class: 'invite-share-layout is-expired' },
                h('div', { class: 'invite-share-copy' },
                    h('p', { class: 'body-md' }, t('invite.expired')),
                    h('div', { class: 'invite-actions' }, regenerate),
                ),
            )
        }
        return h('div', { class: 'invite-share-layout' },
            createInviteQr(createInviteQrPayload(invite.code, 'project'), t('share.project.dialogTitle')),
            h('div', { class: 'invite-share-copy' },
                h('div', { class: 'invite-code' }, invite.code),
                h('div', { class: 'invite-meta label-sm' },
                    invite.singleUse ? h('span', {}, t('invite.singleUse')) : null,
                    // No countdown when the backend sent a bare z32 code: unknown
                    // expiry is not the same as expired.
                    invite.hasExpiry ? h('span', {}, t('invite.expiresIn', { time: invite.countdown })) : null,
                ),
                h('div', { class: 'invite-actions' },
                    showCopy ? h('button', { class: 'btn btn-primary', onclick: copyInvite }, t('desktop.peers.copy')) : null,
                    regenerate,
                ),
            ),
        )
    }

    // Transport diagnostics, in the pane where sharing and peers already live.
    // The rows are the backend's own field names (a copied dump is read next to
    // its logs); the one sentence a user needs — this network blocks direct
    // connections — is the translated note above them.
    function renderNetDiagnostics(state) {
        const t = locale.i18n.t.bind(locale.i18n)
        const net = ui.netDiagnostics
        return h('section', { class: 'pane-section' },
            h('h3', { class: 'category-heading label-sm' }, t('network.diagnostics.title')),
            net?.relayed ? h('p', { class: 'body-md pane-note' }, t('network.diagnostics.relayed')) : null,
            // Rendered as the app's raw-diagnostic idiom (the same monospace log
            // lines the Activity dump uses), not as ten setting-sized kv rows:
            // this is a transport dump to read and copy, and at kv-row weight it
            // was taller than every other section in the pane put together.
            h('div', { class: 'event-log net-diagnostics' },
                ...(net ? net.rows : [['networkStatus', state.networkStatus ?? '—']]).map(([key, value]) => (
                    h('div', { class: 'event-line' },
                        h('span', { class: 'ts' }, key),
                        h('span', {}, value),
                    )
                )),
            ),
            h('div', { class: 'choice-row', style: 'padding: 0.75rem 1rem 0;' },
                h('button', {
                    class: 'btn btn-secondary',
                    disabled: ui.netDiagnosticsBusy ? '' : null,
                    onclick: () => { void actions.refreshNetDiagnostics() },
                }, t('desktop.servers.refresh')),
                net
                    ? h('button', { class: 'btn btn-secondary', onclick: copyNetDiagnostics }, t('network.diagnostics.copy'))
                    : null,
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
                    h('button', { class: 'btn btn-secondary', onclick: () => openDialog({ kind: 'join-list' }) }, t('joinList.button')),
                    h('button', { class: 'btn btn-secondary', onclick: () => openDialog({ kind: 'join' }) }, t('desktop.header.join')),
                ),
            ),
            h('div', { class: 'summary-bar label-md' },
                beacon(state),
                h('span', {}, state.peerCount === 0
                    ? t('desktop.peers.none')
                    : t('desktop.peers.connected', { count: state.peerCount })),
                (() => {
                    const selfKey = (members.find((w) => w.isSelf) || {}).writerKey
                    return selfKey
                        ? h('span', { class: 'self-id' }, h('span', {}, t('members.role.self')), fingerprintChip(selfKey))
                        : null
                })(),
            ),
            h('section', { class: 'pane-section' },
                h('h3', { class: 'category-heading label-sm' }, t('members.title')),
                h('div', { class: 'kv-rows' }, ...renderMemberRows(members)),
            ),
            env.web ? null : buildServersSection(t),
            // Whole-project sharing, moved here out of Settings: this is the pane
            // where a user is already thinking about who else is on the project,
            // and the invite the button mints renders in the next section down.
            // Per-list sharing stays in that list's own settings dialog, so a
            // reflex reach for "share" still cannot hand over every list at once.
            h('section', { class: 'pane-section' },
                h('h3', { class: 'category-heading label-sm' }, t('lists.menu.sectionSharing')),
                h('p', { class: 'body-md pane-note' }, t('share.project.hint')),
                h('div', { class: 'choice-row', style: 'padding: 0.75rem 1rem 0;' },
                    h('button', { class: 'btn btn-secondary', onclick: () => actions.shareProject() }, t('share.project.button')),
                ),
            ),
            h('section', { class: 'pane-section' },
                h('h3', { class: 'category-heading label-sm with-badge' },
                    h('span', {}, t('desktop.peers.invite.title')),
                    // Several codes can be live at once now. A bare count needs no
                    // translation and is the only honest way to show that the code
                    // handed to the last person still works.
                    (state.invite?.liveInvites ?? 0) > 1
                        ? h('span', { class: 'badge' }, String(state.invite.liveInvites))
                        : null,
                ),
                renderInviteBlock(state),
            ),
            renderNetDiagnostics(state),
            LEAF_EXPERIMENT_ENABLED ? renderLeafBridge(state) : null,
            LEAF_EXPERIMENT_ENABLED ? renderVoice(state) : null,
        )
    }

    // Desktop-hosted voice: the leaf streams mic audio to this app's audio
    // bridge; the worker transcribes (whisper via bare-subprocess) and adds the
    // item to THIS list — no separate peer/base. Mock client has no voice(), so
    // the preview shows the unavailable state.
    function renderVoice(state) {
        const t = locale.i18n.t.bind(locale.i18n)
        const section = (...children) => h('section', { class: 'pane-section' },
            h('h3', { class: 'category-heading label-sm' }, t('desktop.voice.title')),
            ...children,
        )
        if (typeof client.voice !== 'function') {
            return section(h('p', { class: 'body-md', style: 'color: var(--secondary); padding: 0 1rem;' }, t('desktop.voice.unavailable')))
        }
        const voice = state.voice
        const running = Boolean(voice?.running)
        const hasModel = Boolean((state.preferences.voiceModelPath || '').trim())
        const modelInput = h('input', {
            class: 'input',
            value: state.preferences.voiceModelPath || '',
            placeholder: t('desktop.voice.modelPlaceholder'),
            disabled: running ? '' : null,
            'aria-label': t('desktop.voice.model'),
            onchange: (event) => actions.setVoiceModelPath(event.target.value),
        })
        // Spoken-language hint: drives BOTH the whisper -l flag and the intent
        // parser's grammar. 'auto' makes the parser fall back to English, so a
        // non-English speaker must pick their language here or commands won't parse.
        const VOICE_LANGS = [['auto', null], ['it', 'app.locale.italian'], ['en', 'app.locale.english'], ['es', 'app.locale.spanish'], ['de', 'app.locale.german'], ['fr', 'app.locale.french'], ['pt', 'app.locale.portuguese']]
        const localeSelect = h('select', {
            class: 'prop-select',
            disabled: running ? '' : null,
            'aria-label': t('header.section.language'),
            onchange: (event) => actions.setVoiceLocale(event.target.value),
        }, ...VOICE_LANGS.map(([v, key]) => {
            const opt = h('option', { value: v }, v === 'auto' ? t('desktop.voice.localeAuto') : t(key))
            if ((state.preferences.voiceLocale || 'auto') === v) opt.setAttribute('selected', 'selected')
            return opt
        }))
        return section(
            h('p', { class: 'body-md', style: 'color: var(--secondary); padding: 0 1rem;' }, t('desktop.voice.description')),
            h('div', { style: 'padding: 0 1rem;' }, modelInput),
            h('div', { class: 'choice-row', style: 'padding: 0.5rem 1rem 0;' }, h('span', { class: 'label-md', style: 'color: var(--secondary);' }, t('header.section.language')), localeSelect),
            h('div', { class: 'summary-bar label-md' },
                h('span', { class: `dot${running ? ' live' : ''}` }),
                h('span', {}, running ? t('desktop.voice.running', { port: voice.port }) : t('desktop.voice.off')),
            ),
            h('div', { class: 'choice-row', style: 'padding: 0 1rem;' },
                h('button', {
                    class: `btn ${running ? 'btn-primary' : 'btn-secondary'}`,
                    'aria-pressed': running ? 'true' : 'false',
                    disabled: (!running && !hasModel) ? 'disabled' : null,
                    onclick: () => actions.setVoice(!running),
                }, running ? t('desktop.voice.disable') : t('desktop.voice.enable')),
            ),
            voice?.error
                ? h('p', { class: 'body-md warning', style: 'padding: 0 1rem;' }, t('desktop.voice.error', { message: voice.error }))
                : null,
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
                        // Leaves are anonymous mirrors — when none is live, show when
                        // one was last seen (hub-observed, not a synced roster peer).
                        : (leaf.lastDisconnectAt
                            ? `${t('desktop.leaf.waiting', { port: leaf.port })} · ${t('presence.lastSeen', { ago: formatAgo(now() - leaf.lastDisconnectAt) })}`
                            : t('desktop.leaf.waiting', { port: leaf.port })))),
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
                    renderLeafBleSection(leaf, t),
                )
                : null,
        )
    }

    // Provision a nearby leaf over Bluetooth straight from the renderer (Web
    // Bluetooth). The leaf is provisioned to dial THIS desktop's bridge, so it
    // reuses store.leafBridge.{controlKey,hubAddr}. Falls back to a hand-off
    // message when Web Bluetooth can't actually drive a chooser here.
    function renderLeafBleSection(leaf, t) {
        // Pear's Electron runtime exposes navigator.bluetooth but never wires up
        // the select-bluetooth-device chooser, so requestDevice() finds nothing
        // and immediately auto-cancels. Treat in-Pear as no-Web-Bluetooth and
        // hand off to the Terminal/mobile path instead of offering a "Pair over
        // Bluetooth" button that can never populate.
        if (!webBluetoothUsable() || !leaf.hubAddr) return renderLeafBleFallback(leaf, t)
        const heading = h('p', { class: 'body-md', style: 'color: var(--secondary); padding: 1rem 1rem 0;' }, t('desktop.leafble.hint'))
        const ssidInput = h('input', { class: 'input', placeholder: t('desktop.leafble.wifiSsid') })
        const pskInput = h('input', { class: 'input', type: 'password', placeholder: t('desktop.leafble.wifiPsk'), style: 'max-width: 220px;' })
        return h('div', {}, heading,
            h('div', { class: 'choice-row', style: 'padding: 0 1rem; gap: 0.5rem;' }, ssidInput, pskInput),
            h('div', { style: 'margin-top: 0.75rem; padding: 0 1rem;' },
                h('button', {
                    class: 'btn btn-primary',
                    onclick: () => pairLeafOverBle(leaf, ssidInput.value, pskInput.value),
                }, t('desktop.leafble.pair'))),
        )
    }

    // Web Bluetooth is only usable in a real browser context (e.g. the ?mock=1
    // design preview). Inside the Pear runtime navigator.bluetooth is present
    // but non-functional — there's no device chooser — so report it unusable.
    function webBluetoothUsable() {
        if (typeof navigator === 'undefined' || !navigator.bluetooth) return false
        const inPear = typeof globalThis.Pear !== 'undefined' && !!globalThis.Pear?.config
        return !inPear
    }

    // Hand-off shown when Bluetooth can't provision the leaf from here. The leaf
    // still needs to dial THIS desktop, so we surface its LAN address and a
    // ready-to-run Terminal command (control key baked in, Wi-Fi to fill) next
    // to the mobile-app option.
    function renderLeafBleFallback(leaf, t) {
        const rows = [
            h('p', { class: 'body-md', style: 'color: var(--secondary); padding: 1rem 1rem 0;' }, t('desktop.leafble.fallback')),
        ]
        if (leaf.controlKey && leaf.hubAddr) {
            const command = leafProvisionCommand(leaf)
            rows.push(
                h('p', { class: 'body-md', style: 'color: var(--secondary); padding: 0 1rem;' }, t('desktop.leafble.fallbackAddr', { addr: leaf.hubAddr })),
                h('p', { class: 'body-md', style: 'color: var(--secondary); padding: 0 1rem;' }, t('desktop.leafble.fallbackTerminal')),
                h('div', { class: 'invite-code', style: 'white-space: pre-wrap; word-break: break-all;' }, command),
                h('div', { style: 'margin-top: 0.75rem; padding: 0 1rem;' },
                    h('button', { class: 'btn btn-secondary', onclick: () => copyLeafCommand(command) }, t('desktop.leafble.copyCmd'))),
            )
        }
        return h('div', {}, ...rows)
    }

    // The exact one-liner listam-headless/tmp-provision-leaf.mjs expects, with
    // this hub's control key + LAN address baked in; the user only fills in
    // their Wi-Fi. NODE_PRESERVE_SYMLINKS=1 lets the symlinked workspace deps
    // (@listam/provisioning) resolve under plain Node.
    function leafProvisionCommand(leaf) {
        return [
            'WIFI_SSID="your-wifi" WIFI_PSK="your-password" \\',
            `CONTROL_KEY="${leaf.controlKey}" HUB_ADDR="${leaf.hubAddr}" \\`,
            'NODE_PRESERVE_SYMLINKS=1 node tmp-provision-leaf.mjs',
        ].join('\n')
    }

    async function pairLeafOverBle(leaf, ssid, psk) {
        const t = locale.i18n.t.bind(locale.i18n)
        if (!navigator.bluetooth) return store.pushNotice(t('desktop.leafble.unavailable'), 'error')
        if (!ssid || !ssid.trim()) return store.pushNotice(t('desktop.leafble.needWifi'), 'error')
        if (!leaf?.controlKey || !leaf?.hubAddr) return store.pushNotice(t('desktop.leafble.noHub'), 'error')
        let server = null
        try {
            const device = await navigator.bluetooth.requestDevice({
                filters: [{ services: [SERVICE_UUID] }, { namePrefix: 'listam-leaf' }],
                optionalServices: [SERVICE_UUID],
            })
            store.pushNotice(t('desktop.leafble.connecting'), 'info')
            server = await device.gatt.connect()
            const service = await server.getPrimaryService(SERVICE_UUID)
            const configChar = await service.getCharacteristic(CHAR_CONFIG_UUID)
            const statusChar = await service.getCharacteristic(CHAR_STATUS_UUID)
            // The negotiated ATT MTU (firmware prefers 247) comfortably fits a
            // ~180-byte frame in one write; the leaf reassembles by offset.
            const transport = {
                mtu: 180,
                async write(_uuid, bytes) {
                    if (configChar.writeValueWithResponse) await configChar.writeValueWithResponse(bytes)
                    else await configChar.writeValue(bytes)
                },
                async subscribe(_uuid, onValue) {
                    await statusChar.startNotifications()
                    const handler = (event) => {
                        const dv = event.target.value
                        onValue(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength))
                    }
                    statusChar.addEventListener('characteristicvaluechanged', handler)
                    return () => {
                        statusChar.removeEventListener('characteristicvaluechanged', handler)
                        statusChar.stopNotifications().catch(() => {})
                    }
                },
            }
            const payload = buildProvisioningPayload({
                controlKey: leaf.controlKey,
                hubAddr: leaf.hubAddr,
                wifi: [{ ssid: ssid.trim(), psk: psk ?? '' }],
                audioAddr: leaf.audioAddr ?? undefined,
            })
            store.pushNotice(t('desktop.leafble.writing'), 'info')
            await provisionLeaf({ transport, payload, mtu: transport.mtu })
            store.pushNotice(t('desktop.leafble.success'), 'success')
        } catch (error) {
            store.pushNotice(t('desktop.leafble.failed', { message: error?.message ?? String(error) }), 'error')
        } finally {
            try {
                server?.disconnect()
            } catch {
                /* already gone — the leaf reboots on success */
            }
        }
    }

    function copyText(text, successKey) {
        return navigator.clipboard.writeText(text).then(
            () => store.pushNotice(locale.i18n.t(successKey), 'success'),
            () => store.pushNotice(locale.i18n.t('invite.share.failed'), 'error'),
        )
    }

    // --- Servers pane (H1 owner-control) -----------------------------------
    // Monitor and reach the user's always-on headless peers (e.g. the Geekom):
    // pair via an operator-minted code, poll a signed, capability-scoped status
    // command over hyperdht, and issue safe controls (mint invite, export,
    // shutdown). Requires the Pear runtime; the browser preview shows the
    // unavailable state.
    //
    // The section lives in ./ui/servers.mjs and owns its own per-server cache.
    // renderAll/openDialog/closeDialog/copyText are function declarations, so
    // they are already bound at this point even though they appear later.
    const {
        buildServersSection,
        refreshAllServers,
        shutdownServer,
    } = createServersSection({ ownerControl, store, locale, now, renderAll, openDialog, closeDialog, copyText })

    function renderMemberRows(members) {
        const t = locale.i18n.t.bind(locale.i18n)
        if (members.length === 0) {
            return [h('p', { class: 'body-md', style: 'color: var(--secondary); padding: 0 1rem;' }, t('members.subtitle.none'))]
        }
        const canAdminister = store.getState().roster?.canAdminister
        // Synced device name on line 1, copyable fingerprint on line 2 — every
        // member is legible (name or self label) AND its key is grabbable.
        return members.map((member) => {
            const pd = peerDisplay(member.writerKey)
            const meta = presenceMeta(member.writerKey)
            return h('div', { class: 'member-row' },
                presenceDot(member.writerKey),
                h('div', { class: 'who' },
                    h('span', { class: 'who-name', title: pd.title }, pd.name || (member.isSelf ? t('members.role.self') : pd.short)),
                    fingerprintChip(member.writerKey),
                    meta ? h('span', { class: 'presence-meta' }, meta) : null,
                ),
                presenceStatus(member.writerKey),
                h('span', { class: `role-chip${member.isOwner ? ' owner' : ''}` },
                    member.isOwner ? t('members.role.owner') : member.isSelf ? t('members.role.self') : t('members.role.member')),
                canAdminister && !member.isSelf && !member.isOwner
                    ? h('button', { class: 'btn btn-danger', onclick: () => actions.removeMember(member) }, t('common.remove'))
                    : h('span', {}),
            )
        })
    }

    // Activity analytics body (used inside Settings → Analytics): a health
    // summary plus the recent backend event log. Returns the nodes.
    function activityContent(state) {
        const t = locale.i18n.t.bind(locale.i18n)
        return [
            h('h4', { class: 'analytics-subhead label-sm' }, t('desktop.diagnostics.summary')),
            h('div', { class: 'kv-rows' },
                kvRow(t('desktop.diagnostics.backendReady'), state.backendReady ? t('header.status.ready') : t('header.status.starting')),
                kvRow(t('desktop.diagnostics.peerCount'), String(state.peerCount)),
                kvRow(t('desktop.diagnostics.joinPhase'), state.joinPhase ?? '—'),
                kvRow(t('desktop.diagnostics.locale'), `${locale.i18n.locale} / ${locale.i18n.groceryLocale}`),
            ),
            h('h4', { class: 'analytics-subhead label-sm' }, t('desktop.diagnostics.events')),
            state.diagnostics.length === 0
                ? h('p', { class: 'body-md analytics-note' }, t('desktop.diagnostics.empty'))
                : h('div', { class: 'event-log' },
                    ...state.diagnostics.slice().reverse().map((entry) => h('div', { class: 'event-line' },
                        h('span', { class: 'ts' }, formatTime(entry.at)),
                        h('span', {}, entry.label),
                    ))),
        ]
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

    // Probe the transport. Deliberately request/response rather than a
    // subscription: this is a "what is happening right now" answer a user asks
    // for while a share is failing, not a stream worth keeping open.
    async function refreshNetDiagnostics() {
        if (ui.netDiagnosticsBusy) return
        ui.netDiagnosticsBusy = true
        try {
            // Deliberately `client.send`, NOT the wrapped `send()`: this is a
            // read-only probe that answers { ok: true } and runs on the peers
            // pane's 20s tick. Through send() every one of those replies would
            // call clearWriteBlock() and erase a live "writes are refused"
            // banner that nothing has actually resolved — and every failed probe
            // would toast backend.startFailed on the same tick.
            const reply = parseReply(await client.send(RPC_GET_NET_DIAGNOSTICS))
            ui.netDiagnostics = describeNetDiagnostics(reply, { networkStatus: store.getState().networkStatus })
        } catch {
            // A dead worker already surfaces through the write-block banner; an
            // empty diagnostics panel must not be mistaken for "all fields false".
            ui.netDiagnostics = null
        } finally {
            ui.netDiagnosticsBusy = false
            renderAll()
        }
    }

    async function copyNetDiagnostics() {
        const text = ui.netDiagnostics?.text
        if (!text) return
        try {
            await navigator.clipboard.writeText(text)
            store.pushNotice(locale.i18n.t('network.diagnostics.copied'), 'success')
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

    async function copyLeafCommand(command) {
        try {
            await navigator.clipboard.writeText(command)
            store.pushNotice(locale.i18n.t('desktop.leafble.cmdCopied'), 'success')
        } catch {
            store.pushNotice(locale.i18n.t('invite.share.failed'), 'error')
        }
    }

    // --- dialogs -------------------------------------------------------------
    // ⌘K command palette: fuzzy go-to-anything (rail surfaces + active-surface
    // items) + an action launcher. Filters/repaints its result list IMPERATIVELY
    // per keystroke — openDialog calls renderAll, so a renderAll-on-input would
    // rebuild the field and drop focus/caret.
    function renderCommandPalette(state) {
        const t = locale.i18n.t.bind(locale.i18n)
        const onLists = ui.view === 'lists'
        const entries = []
        const act = (icon, label, run) => entries.push({ group: 'actions', icon, label, tag: '', run })
        const jmp = (icon, label, tag, run) => entries.push({ group: 'jump', icon, label, tag, run })
        act('plus', t('desktop.shortcuts.addItem'), () => { closeDialog(); actions.summonAddBar() })
        act('users', t('joinList.button'), () => openDialog({ kind: 'join-list' }))
        if (onLists) act('layout-grid', t('header.action.gridView'), () => { closeDialog(); preferencesToggle('isGridView') })
        act('check', t('main.summary.clearDone'), () => { closeDialog(); actions.clearDone() })
        act('contrast', t('desktop.shortcuts.cycleTheme'), () => { closeDialog(); actions.cycleTheme() })
        act('settings', t('desktop.nav.settings'), () => openDialog({ kind: 'settings' }))
        act('info-circle', t('desktop.shortcuts.help'), () => openDialog({ kind: 'shortcuts' }))
        jmp('layout-dashboard', t('desktop.nav.overview'), '', () => { closeDialog(); ui.view = 'overview'; renderAll() })
        jmp('users', t('desktop.nav.peers'), '', () => { closeDialog(); ui.view = 'peers'; void refreshNetDiagnostics(); renderAll() })
        jmp('activity', t('desktop.analytics.title'), '', () => { closeDialog(); ui.view = 'analytics'; renderAll() })
        for (const g of buildRail(state).groups) {
            for (const s of g.surfaces) {
                jmp(iconForType(s.type), s.name, g.name || '', () => { closeDialog(); selectSurface(store.getState(), s) })
            }
        }
        if (onLists || ui.view === 'todo' || ui.view === 'board') {
            const surfName = activeSurface(state)?.name || ''
            for (const it of itemsForActiveList(state).slice(0, 150)) {
                jmp('point', it.text, surfName, () => { closeDialog(); ui.focusedItemId = it.id; renderAll() })
            }
        }
        // Rank: prefix > substring > subsequence. Empty query keeps source order.
        const score = (label, q) => {
            if (!q) return 1
            const l = label.toLowerCase()
            if (l.startsWith(q)) return 3
            if (l.includes(q)) return 2
            let i = 0
            for (const ch of l) { if (ch === q[i]) i++; if (i === q.length) return 1 }
            return 0
        }
        let sel = 0
        const rowEls = []
        const results = h('div', { class: 'palette-results', role: 'listbox' })
        function rebuild(raw) {
            const q = raw.trim().toLowerCase()
            const top = entries.map((e) => ({ e, s: score(e.label, q) })).filter((x) => x.s > 0)
                .sort((a, b) => b.s - a.s).slice(0, 40)
            sel = 0
            rowEls.length = 0
            results.replaceChildren()
            let lastGroup = null
            top.forEach((x, idx) => {
                if (x.e.group !== lastGroup) {
                    lastGroup = x.e.group
                    results.append(h('div', { class: 'palette-group label-sm' }, x.e.group === 'actions' ? t('palette.actions') : t('palette.jump')))
                }
                const row = h('div', {
                    class: `palette-row${idx === 0 ? ' selected' : ''}`,
                    role: 'option',
                    onmousedown: (ev) => ev.preventDefault(),
                    onclick: () => x.e.run(),
                },
                    tablerIcon(x.e.icon, { size: 16 }),
                    h('span', { class: 'palette-label' }, x.e.label),
                    x.e.tag ? h('span', { class: 'palette-tag label-sm' }, x.e.tag) : null,
                )
                results.append(row)
                rowEls.push({ row, run: x.e.run })
            })
            if (!rowEls.length) results.append(h('div', { class: 'palette-empty label-md' }, t('palette.empty')))
        }
        function setSel(next) {
            if (!rowEls.length) return
            sel = (next + rowEls.length) % rowEls.length
            rowEls.forEach((r, i) => r.row.classList.toggle('selected', i === sel))
            rowEls[sel].row.scrollIntoView({ block: 'nearest' })
        }
        const input = h('input', {
            class: 'palette-input',
            placeholder: t('palette.placeholder'),
            'aria-label': t('palette.placeholder'),
            oninput: (ev) => rebuild(ev.target.value),
            onkeydown: (ev) => {
                if (ev.key === 'ArrowDown') { ev.preventDefault(); setSel(sel + 1) }
                else if (ev.key === 'ArrowUp') { ev.preventDefault(); setSel(sel - 1) }
                else if (ev.key === 'Enter') { ev.preventDefault(); if (rowEls[sel]) rowEls[sel].run() }
                else if (ev.key === 'Escape') { ev.preventDefault(); closeDialog() }
            },
        })
        rebuild('')
        queueMicrotask(() => input.focus())
        return h('div', { class: 'dialog command-palette', role: 'dialog', 'aria-modal': 'true' },
            h('div', { class: 'palette-search' }, tablerIcon('search', { size: 16 }), input),
            results,
            h('div', { class: 'palette-footer label-sm' }, t('palette.footer')),
        )
    }

    // Scroll offset + focused field are the only dialog state the DOM owns, and a
    // dialog is rebuilt wholesale on every render (no VDOM), which used to throw
    // both away several times a minute on a live mesh. See ./ui/dialog-dom-state.mjs.
    const dialogDom = createDialogDomState()

    function renderDialog(state) {
        if (!ui.dialog && state.recovery) {
            // Phase 11 parity: surface the storage-recovery decision as soon as
            // the backend reports it.
            ui.dialog = { kind: 'recovery' }
        }
        if (!ui.dialog) {
            dialogHost.replaceChildren()
            dialogDom.clear()
            return
        }
        const t = locale.i18n.t.bind(locale.i18n)
        const { kind } = ui.dialog
        let content = null

        if (kind === 'command-palette') {
            content = renderCommandPalette(state)
        } else if (kind === 'plan-move') {
            const draft = ui.dialog
            const pick = (dateKey) => {
                // ISO date-only parsing measures calendar days in UTC, avoiding
                // an off-by-one week when the local DST offset changes.
                ui.weekOffset = Math.floor((Date.parse(dateKey) - Date.parse(toDateKey(now()))) / (7 * 86400000))
                ui.planDate = dateKey
                actions.movePlanToDay(draft.ref, dateKey)
                closeDialog()
            }
            const calendar = renderPlanCalendar({ draft, today: toDateKey(now()), i18n: locale.i18n, onPick: pick })
            content = dialogFrame(t('plan.pickDate'), [
                h('p', { class: 'plan-calendar-entry' }, draft.label),
                calendar,
            ], [
                h('button', { class: 'btn btn-secondary', onclick: () => pick(toDateKey(now())) }, t('plan.today')),
                h('button', { class: 'btn btn-primary', onclick: closeDialog }, t('common.cancel')),
            ])
            content.classList.add('plan-calendar-dialog')
            content.setAttribute('aria-label', t('plan.pickDate'))
            // Keep keyboard navigation inside this modal, and restore the active
            // day if a background update rebuilds it while the calendar is focused.
            content.addEventListener('keydown', (event) => {
                if (event.key !== 'Tab') return
                const fields = [...content.querySelectorAll('button:not([disabled]), input')].filter((el) => el.tabIndex >= 0)
                const first = fields[0]
                const last = fields[fields.length - 1]
                if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
                else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
            })
            if (dialogDom.shouldEnter(kind) || dialogHost.querySelector('.plan-calendar-day:focus')) {
                queueMicrotask(() => calendar.querySelector('[tabindex="0"]')?.focus())
            }
        } else if (kind === 'plan-day') {
            const item = ui.dialog.item
            const today = toDateKey(now())
            const week = Array.from({ length: 7 }, (_, i) => shiftDateKey(today, i))
            const pick = (dateKey) => { actions.flagItemForDay(item, dateKey); closeDialog() }
            const dayBtn = (dk, label) => h('button', { class: 'btn btn-secondary plan-day-opt', onclick: () => pick(dk) },
                h('span', {}, label),
                h('span', { class: 'label-sm', style: 'color: var(--secondary)' }, String(parsePlanKey(dk).getDate())),
            )
            const dateInput = h('input', {
                class: 'input', type: 'date', value: today, min: today,
                onchange: () => { if (dateInput.value) pick(dateInput.value) },
            })
            content = dialogFrame(t('plan.planFor'), [
                h('div', { class: 'plan-day-grid' },
                    dayBtn(today, t('plan.today')),
                    dayBtn(week[1], t('plan.tomorrow')),
                    ...week.slice(2).map((dk) => dayBtn(dk, parsePlanKey(dk).toLocaleDateString(undefined, { weekday: 'long' }))),
                ),
                h('label', { class: 'plan-day-custom' },
                    h('span', { class: 'label-sm' }, t('plan.pickDate')),
                    dateInput,
                ),
            ], [
                plannedRefs.has(planItemKey(item.listId, item.id))
                    ? h('button', { class: 'btn btn-secondary', onclick: () => { actions.clearFromPlan(planItemKey(item.listId, item.id)); closeDialog() } }, t('plan.clearFromPlan'))
                    : null,
                h('button', { class: 'btn btn-primary', onclick: closeDialog }, t('common.close')),
            ])
        } else if (kind === 'share' || kind === 'share-list') {
            const scope = kind === 'share-list' ? 'list' : 'project'
            const model = ui.dialog.invitePanel
            content = dialogFrame(t(scope === 'list' ? 'shareList.title' : 'share.project.dialogTitle'), [
                h('p', { class: 'body-md' }, t(scope === 'list' ? 'shareList.message' : 'share.project.dialogMessage')),
                renderInvitePanel({ model, scope, t, now: now(), refresh: renderAll,
                    generate: () => generateInvitationBatch(model, ui.dialog.baseKey),
                    copy: async (key) => {
                        try { await navigator.clipboard.writeText(key); store.pushNotice(t('desktop.peers.copied'), 'success') }
                        catch { store.pushNotice(t('invite.share.failed'), 'error') }
                    },
                }),
            ], [h('button', { class: 'btn btn-secondary', onclick: closeDialog }, t('common.close'))], { className: 'invite-dialog' })
        } else if (kind === 'join-list') {
            const joinListInput = h('input', {
                class: 'input', value: ui.dialog.value || '', id: 'join-list-code',
                placeholder: t('invite.dialog.placeholder'),
                onkeydown: (event) => { if (event.key === 'Enter') actions.joinList(joinListInput.value) },
            })
            content = dialogFrame(t('joinList.title'), [
                h('p', { class: 'dialog-body' }, t('joinList.subtitle')),
                ui.dialog.errorKey ? h('p', { class: 'invite-panel-error', role: 'alert' }, t(ui.dialog.errorKey)) : null,
                joinListInput,
            ], [
                h('button', { class: 'btn btn-secondary', onclick: closeDialog }, t('common.cancel')),
                h('button', { class: 'btn btn-primary', onclick: () => actions.joinList(joinListInput.value) }, t('common.join')),
            ])
            queueMicrotask(() => joinListInput.focus())
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
                h('p', { class: 'trust-reassure label-md' }, tablerIcon('check', { size: 14 }), h('span', {}, t('invite.confirm.backupNote'))),
            ], [
                h('button', { class: 'btn btn-secondary', onclick: closeDialog }, t('common.cancel')),
                h('button', { class: 'btn btn-danger', onclick: () => actions.confirmJoin(ui.dialog.invite) }, t('invite.confirm.replace')),
            ], { trust: true })
        } else if (kind === 'settings') {
            // This device's name, advertised to peers (synced peer label). Commit
            // on Enter/blur; setDeviceName stores the local copy and writes the
            // label once this device's writer key is known.
            const deviceNameInput = h('input', {
                class: 'input',
                value: state.preferences.deviceName || '',
                placeholder: t('desktop.settings.deviceName.placeholder'),
                maxlength: '64',
            })
            const commitDeviceName = () => {
                const nv = deviceNameInput.value.trim()
                if (nv !== (state.preferences.deviceName || '')) actions.setDeviceName(nv)
            }
            deviceNameInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') { commitDeviceName(); deviceNameInput.blur() } })
            deviceNameInput.addEventListener('blur', commitDeviceName)
            const themeRow = h('div', { class: 'segmented', role: 'group', 'aria-label': t('desktop.theme.label') },
                ...THEME_CHOICES.map((choice) => h('button', {
                    class: `seg ${state.preferences.theme === choice ? 'active' : ''}`,
                    'aria-pressed': state.preferences.theme === choice ? 'true' : 'false',
                    onclick: () => store.setPreferences({ theme: choice }),
                }, t(`desktop.theme.${choice}`))),
            )
            const hintsOn = state.preferences.showKeyHints
            const hintsRow = h('label', { class: 'switch-row' },
                h('span', { class: 'switch-hint label-md' },
                    hintsOn ? t('desktop.settings.shown') : t('desktop.settings.hidden'), ' ', h('kbd', {}, 'H')),
                h('span', { class: `switch${hintsOn ? ' on' : ''}` },
                    h('input', { type: 'checkbox', class: 'switch-input', role: 'switch', 'aria-checked': hintsOn ? 'true' : 'false', checked: hintsOn ? '' : null, onchange: () => actions.toggleHints() }),
                    h('span', { class: 'switch-knob' }),
                ),
            )
            const languageRow = h('div', { class: 'segmented segmented-wrap', role: 'group', 'aria-label': t('header.section.language') },
                ...LOCALE_CHOICES.map((choice) => h('button', {
                    class: `seg ${locale.choice === choice ? 'active' : ''}`,
                    'aria-pressed': locale.choice === choice ? 'true' : 'false',
                    onclick: () => locale.setChoice(choice),
                }, localeChoiceLabel(locale.i18n, choice))),
            )
            const boardCfg = selectBoardConfig(state)
            const canEditRigor = !!(state.boardConfigCanAdminister || state.roster?.canAdminister)
            const rigorRow = canEditRigor
                ? h('div', { class: 'segmented', role: 'group', 'aria-label': t('settings.rigor.label') },
                    h('button', {
                        class: `seg ${boardCfg.rigorOn ? 'active' : ''}`,
                        'aria-pressed': boardCfg.rigorOn ? 'true' : 'false',
                        onclick: () => actions.setRigor(true),
                    }, t('settings.rigor.on')),
                    h('button', {
                        class: `seg ${!boardCfg.rigorOn ? 'active' : ''}`,
                        'aria-pressed': !boardCfg.rigorOn ? 'true' : 'false',
                        onclick: () => actions.setRigor(false),
                    }, t('settings.rigor.off')),
                )
                : h('p', { class: 'body-md', style: 'color: var(--secondary);' },
                    `${boardCfg.rigorOn ? t('settings.rigor.on') : t('settings.rigor.off')} — ${t('settings.rigor.readonlyHelp')}`)
            // Per-device gate for offering board creation. Always lets existing
            // boards stay visible; only the "New board" option is hidden when off.
            const boardRow = h('div', { class: 'segmented', role: 'group', 'aria-label': t('settings.board.label') },
                h('button', {
                    class: `seg ${state.preferences.boardEnabled ? 'active' : ''}`,
                    'aria-pressed': state.preferences.boardEnabled ? 'true' : 'false',
                    onclick: () => store.setPreferences({ boardEnabled: true }),
                }, t('settings.board.on')),
                h('button', {
                    class: `seg ${!state.preferences.boardEnabled ? 'active' : ''}`,
                    'aria-pressed': !state.preferences.boardEnabled ? 'true' : 'false',
                    onclick: () => store.setPreferences({ boardEnabled: false }),
                }, t('settings.board.off')),
            )
            content = dialogFrame(t('desktop.settings.title'), [h('div', { class: 'settings' },
                h('h3', { class: 'category-heading label-sm' }, t('desktop.settings.deviceName.label')),
                deviceNameInput,
                h('p', { class: 'label-md', style: 'color: var(--secondary);' }, t('desktop.settings.deviceName.help')),
                // This device's own writer key — the public identifier peers use to
                // tell devices apart. Shown so a user can match this device against a
                // row in Peers & Devices (e.g. to check why a name isn't syncing).
                // Prefer the roster's localWriterKey (present even before this device
                // is an accepted writer) so the key shows the moment the base opens.
                h('h3', { class: 'category-heading label-sm' }, t('desktop.settings.deviceKey.label')),
                (() => {
                    const key = state.roster?.localWriterKey || state.roster?.writers?.find((w) => w.isSelf)?.writerKey || ''
                    if (!key) return h('p', { class: 'label-md', style: 'color: var(--secondary);' }, t('desktop.settings.deviceKey.pending'))
                    return h('div', { class: 'device-key-row', style: 'display: flex; align-items: center; gap: 0.5rem;' },
                        h('code', { class: 'device-key-value', style: 'flex: 1; min-width: 0; overflow-wrap: anywhere; word-break: break-all; user-select: text; font-size: 0.72rem; line-height: 1.35; color: var(--secondary);' }, key),
                        h('button', {
                            class: 'fingerprint-chip',
                            type: 'button',
                            title: t('desktop.leaf.copy'),
                            'aria-label': t('desktop.leaf.copy'),
                            onclick: () => copyText(key, 'desktop.settings.deviceKey.copied'),
                        }, tablerIcon('copy', { size: 12 })),
                    )
                })(),
                h('p', { class: 'label-md', style: 'color: var(--secondary);' }, t('desktop.settings.deviceKey.help')),
                h('h3', { class: 'category-heading label-sm' }, t('desktop.theme.label')),
                themeRow,
                h('h3', { class: 'category-heading label-sm' }, t('desktop.hints.show')),
                hintsRow,
                h('h3', { class: 'category-heading label-sm' }, t('settings.rigor.label')),
                rigorRow,
                canEditRigor ? h('p', { class: 'label-md', style: 'color: var(--secondary);' }, t('settings.rigor.ownerHelp')) : null,
                h('h3', { class: 'category-heading label-sm' }, t('settings.board.label')),
                boardRow,
                h('p', { class: 'label-md', style: 'color: var(--secondary);' }, t('settings.board.help')),
                h('h3', { class: 'category-heading label-sm' }, t('header.section.language')),
                languageRow,
                // Whole-project sharing is NOT here: it lives in the Peers &
                // Devices pane, next to the roster and the invite it mints, which
                // is where a user goes when they are thinking about who else is on
                // this project. Per-list sharing stays in that list's settings.
                h('h3', { class: 'category-heading label-sm' }, t('backup.section')),
                h('div', { class: 'choice-row' },
                    h('button', { class: 'btn btn-secondary', onclick: () => openDialog({ kind: 'backup', mode: 'export-data' }) }, t('backup.exportData')),
                    h('button', { class: 'btn btn-secondary', onclick: () => startBackupImport() }, t('backup.import')),
                ),
                h('p', { class: 'label-md', style: 'color: var(--secondary);' }, t('backup.exportData.desc')),
                h('div', { class: 'choice-row' },
                    h('button', { class: 'btn btn-secondary', onclick: () => openDialog({ kind: 'backup', mode: 'export-seed' }) }, t('backup.exportSeed')),
                ),
                h('p', { class: 'label-md', style: 'color: var(--secondary);' }, t('backup.exportSeed.desc')),
                h('h3', { class: 'category-heading label-sm' }, t('backup.auto.section')),
                h('p', { class: 'label-md', style: 'color: var(--secondary);' }, t('backup.auto.desc')),
                h('div', { class: 'choice-row' },
                    h('button', { class: 'btn btn-secondary', onclick: () => openDialog({ kind: 'backup', mode: 'set-password' }) },
                        ui.backupPasswordSet ? t('backup.auto.changePassword') : t('backup.auto.setPassword')),
                ),
                ui.backupPasswordSet === false
                    ? h('p', { class: 'label-md', style: 'color: var(--secondary);' }, t('backup.auto.required'))
                    : (ui.backups && ui.backups.length)
                        ? h('div', {}, ...ui.backups.map((b) => h('div', { class: 'choice-row' },
                            h('span', { class: 'label-md', style: 'flex:1; color: var(--secondary);' }, new Date(b.createdAt).toLocaleString()),
                            h('button', { class: 'btn btn-secondary', onclick: () => openDialog({ kind: 'backup', mode: 'restore', file: b.file }) }, t('backup.auto.restore')),
                        )))
                        : h('p', { class: 'label-md', style: 'color: var(--secondary);' }, t('backup.auto.empty')),
                // Rolling scheduled backups (15-min / daily / weekly). The
                // backend runs these automatically once a backup password is
                // set; here we only surface the on/off toggle + last-run times.
                h('h3', { class: 'category-heading label-sm' }, t('backup.schedule.section')),
                h('p', { class: 'label-md', style: 'color: var(--secondary);' }, t('backup.schedule.desc')),
                ui.backupPasswordSet === false
                    ? h('p', { class: 'label-md', style: 'color: var(--secondary);' }, t('backup.schedule.required'))
                    : (() => {
                        const schedule = ui.backupSchedule
                        const enabled = schedule ? schedule.enabled !== false : true
                        const tiers = (schedule && Array.isArray(schedule.tiers)) ? schedule.tiers : []
                        const at = now()
                        // Localise each cadence by its stable reason; fall back to
                        // the backend-supplied label if a new reason ever appears.
                        const tierLabel = (tier) => {
                            const key = `backup.schedule.tier.${String(tier.reason || '').replace('scheduled-', '')}`
                            const localised = t(key)
                            return localised === key ? (tier.label || key) : localised
                        }
                        return h('div', {},
                            h('div', { class: 'choice-row' },
                                h('button', {
                                    class: `btn ${enabled ? 'btn-primary' : 'btn-secondary'}`,
                                    'aria-pressed': enabled ? 'true' : 'false',
                                    onclick: () => { if (!enabled) runSetBackupSchedule(true) },
                                }, t('backup.schedule.on')),
                                h('button', {
                                    class: `btn ${!enabled ? 'btn-primary' : 'btn-secondary'}`,
                                    'aria-pressed': !enabled ? 'true' : 'false',
                                    onclick: () => { if (enabled) runSetBackupSchedule(false) },
                                }, t('backup.schedule.off')),
                            ),
                            ...tiers.map((tier) => h('div', { class: 'choice-row' },
                                h('span', { class: 'label-md', style: 'flex:1; color: var(--secondary);' }, tierLabel(tier)),
                                h('span', { class: 'label-md', style: 'color: var(--secondary);' },
                                    tier.lastAt
                                        ? t('backup.schedule.tier.last', { time: formatAgo(at - tier.lastAt) })
                                        : t('backup.schedule.tier.never')),
                            )),
                        )
                    })(),
                // Flatten history. Owner-only, and rendered only once the backend
                // has reported readiness — the section's whole value is naming
                // which device is holding it back, so an unanswered one says
                // nothing worth showing.
                renderCompactionSection({
                    onConfirm: confirmCompaction,
                    isOwner: !!state.roster?.canAdminister,
                }),
                // Diagnostics is a LINK, not a block. The health summary plus the
                // rolling backend event log is a wall of monospace nobody scrolls
                // Settings to read, and it pushed everything below it out of
                // reach; it now opens as its own page and comes back here on Back.
                // Congruency analytics left Settings entirely — it is a pane under
                // Peers & Devices in the sidebar.
                h('h3', { class: 'category-heading label-sm' }, t('desktop.diagnostics.title')),
                h('div', { class: 'choice-row' },
                    h('button', { class: 'btn btn-secondary', onclick: () => openDialog({ kind: 'diagnostics' }) }, t('desktop.diagnostics.open')),
                ),
                h('p', { class: 'label-md', style: 'color: var(--secondary);' }, t('desktop.diagnostics.hint')),
            )], [
                h('button', { class: 'btn btn-primary', onclick: closeDialog }, t('common.close')),
            ])
        } else if (kind === 'diagnostics') {
            // The Settings sub-page. Back returns to Settings rather than closing
            // outright, so opening it is not a dead end that costs a re-navigation.
            content = dialogFrame(t('desktop.diagnostics.title'), [
                h('div', { class: 'analytics-section' }, ...activityContent(state)),
            ], [
                h('button', { class: 'btn btn-secondary', onclick: () => openDialog({ kind: 'settings' }) }, t('common.back')),
                h('button', { class: 'btn btn-primary', onclick: closeDialog }, t('common.close')),
            ])
        } else if (kind === 'backup') {
            const mode = ui.dialog.mode
            const isImport = mode === 'import'
            const isRestore = mode === 'restore'
            const isSetPassword = mode === 'set-password'
            const isSeedExport = mode === 'export-seed'
            const isSeedRestore = isImport && ui.dialog.fileKind === 'seed'
            // password-only entry (import + restore); set-password also confirms,
            // and a CHANGE additionally asks for the current password.
            const passwordOnly = isImport || isRestore
            const needsCurrent = isSetPassword && ui.backupPasswordSet === true
            const title = isRestore ? t('backup.auto.restore')
                : isSetPassword ? (ui.backupPasswordSet ? t('backup.auto.changePassword') : t('backup.auto.setPassword'))
                    : isImport ? t('backup.import')
                        : isSeedExport ? t('backup.exportSeed') : t('backup.exportData')
            const currentInput = needsCurrent ? h('input', { class: 'input', type: 'password', placeholder: t('backup.auto.currentPassword'), autocomplete: 'current-password' }) : null
            const passwordInput = h('input', { class: 'input', type: 'password', placeholder: t('backup.password.placeholder'), autocomplete: 'new-password' })
            const confirmInput = passwordOnly ? null : h('input', { class: 'input', type: 'password', placeholder: t('backup.password.confirm'), autocomplete: 'new-password' })
            const submit = () => {
                const password = passwordInput.value
                if (passwordOnly) {
                    if (!password) { store.pushNotice(t('backup.password.tooShort'), 'error'); return }
                    if (isRestore) runRestoreAutoBackup(ui.dialog.file, password)
                    else runBackupImport(ui.dialog.fileText, password)
                    return
                }
                if (password.length < 8) { store.pushNotice(t('backup.password.tooShort'), 'error'); return }
                if (password !== confirmInput.value) { store.pushNotice(t('backup.password.mismatch'), 'error'); return }
                if (isSetPassword) runSetBackupPassword(needsCurrent ? currentInput.value : undefined, password)
                else runBackupExport(mode, password)
            }
            const onkeydown = (event) => { if (event.key === 'Enter') submit() }
            if (currentInput) currentInput.addEventListener('keydown', onkeydown)
            passwordInput.addEventListener('keydown', onkeydown)
            if (confirmInput) confirmInput.addEventListener('keydown', onkeydown)
            content = dialogFrame(title, [
                isSeedExport ? h('p', { class: 'warning' }, t('backup.seed.warn')) : null,
                isSeedRestore ? h('p', { class: 'warning' }, t('backup.seed.restoreWarn')) : null,
                h('p', { class: 'dialog-body' }, passwordOnly ? t('backup.password.enter') : t('backup.password.create')),
                currentInput,
                passwordInput,
                confirmInput,
            ], [
                h('button', { class: 'btn btn-secondary', onclick: closeDialog }, t('backup.cancel')),
                h('button', {
                    class: `btn ${isSeedRestore ? 'btn-danger' : 'btn-primary'}`,
                    onclick: submit,
                }, isSetPassword ? t('common.save') : passwordOnly ? t('backup.unlockImport') : t('backup.encryptExport')),
            ])
            queueMicrotask(() => (currentInput || passwordInput).focus())
        } else if (kind === 'list-create') {
            const registry = reduceRegistry(state.items)
            const createType = ui.dialog.createType || 'shopping'
            const isGroup = createType === 'group'
            const typeOptions = [
                { type: 'shopping', label: t('desktop.rail.groceries') },
                { type: TODO_LIST_TYPE, label: t('desktop.rail.todo') },
                ...(state.preferences.boardEnabled ? [{ type: BOARD_WRITE_TYPE, label: t('desktop.rail.board') }] : []),
                { type: NOTES_LIST_TYPE, label: t('desktop.rail.notes') },
                { type: 'group', label: t('desktop.group.label') },
            ]
            const typeRow = h('div', { class: 'choice-row' }, ...typeOptions.map((o) => h('button', {
                class: `btn ${createType === o.type ? 'btn-primary' : 'btn-secondary'}`,
                onclick: () => { ui.dialog.createType = o.type; renderAll() },
            }, o.label)))
            const nameInput = h('input', { class: 'input', placeholder: t('desktop.list.namePlaceholder') })
            // Every list needs a group; always offer "general" (the default home)
            // even before its meta-item has synced, and preselect it.
            const groupChoices = [...registry.groups]
            if (!groupChoices.some((g) => g.id === GENERAL_GROUP_ID)) groupChoices.unshift({ id: GENERAL_GROUP_ID, name: t('desktop.group.general') })
            const defaultGroupId = ui.dialog.groupId || GENERAL_GROUP_ID
            const groupSelect = h('select', { class: 'prop-select' }, ...groupChoices.map((g) => {
                const opt = h('option', { value: g.id }, g.name)
                if (g.id === defaultGroupId) opt.setAttribute('selected', 'selected')
                return opt
            }))
            const submit = () => {
                const name = nameInput.value.trim()
                if (!name) { store.pushNotice(t('desktop.list.nameRequired'), 'error'); return }
                if (isGroup) actions.createGroup({ name })
                else actions.createList({ name, type: createType, groupId: groupSelect.value || GENERAL_GROUP_ID })
                closeDialog()
            }
            nameInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') submit() })
            content = dialogFrame(t('desktop.list.create.title'), [
                h('h3', { class: 'category-heading label-sm' }, t('desktop.list.type')),
                typeRow,
                nameInput,
                isGroup ? null : h('h3', { class: 'category-heading label-sm' }, t('desktop.list.group')),
                isGroup ? null : groupSelect,
            ], [
                h('button', { class: 'btn btn-secondary', onclick: closeDialog }, t('common.cancel')),
                h('button', { class: 'btn btn-primary', onclick: submit }, t('desktop.list.create')),
            ])
            queueMicrotask(() => nameInput.focus())
        } else if (kind === 'list-settings' && ui.dialog.builtinType) {
            // Former built-in surface (Groceries/Board/Todo): synced rename via a
            // surface label. It lives in "general" and has no registry meta-item
            // of its own. Grocery can be promoted into an ordinary shared list;
            // deleting it writes the synced built-in visibility marker.
            const type = ui.dialog.builtinType
            const listId = ui.dialog.listId
            const isGroceryBuiltin = !isBoardType(type) && !isTodoType(type)
            const resolvedName = builtinDisplayName(type, reduceSurfaceLabels(state.items))
            const nameInput = h('input', { id: 'list-settings-name', class: 'input', value: resolvedName, 'aria-label': t('desktop.list.rename') })
            // Empty clears the override (reverts to the localized default).
            const commitName = () => { const nv = nameInput.value.trim(); if (nv !== resolvedName) actions.renameBuiltin(listId, type, nv) }
            nameInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') { commitName(); closeDialog() } })
            nameInput.addEventListener('blur', commitName)
            content = dialogFrame(resolvedName || t('desktop.list.settings'), [
                h('h3', { class: 'category-heading label-sm' }, t('desktop.list.rename')),
                nameInput,
                h('p', { class: 'label-md', style: 'color: var(--secondary);' }, t('desktop.list.renameBuiltinHelp')),
                listIdentityBlock(listId, type),
                listMembersBlock(listId),
                isGroceryBuiltin ? listSharingBlock(false, () => {
                    const name = nameInput.value.trim() || resolvedName
                    closeDialog()
                    actions.shareList(listId, { type, name, builtin: true })
                }) : null,
                listRigorToggle(listId, type),
                valueReturnToggleRow(listId, type),
            ], [
                h('button', {
                    class: 'btn btn-danger',
                    onclick: () => {
                        if (!ui.dialog.confirmDelete) { ui.dialog.confirmDelete = true; renderAll(); return }
                        actions.deleteBuiltin(listId, type)
                        closeDialog()
                    },
                }, ui.dialog.confirmDelete ? t('desktop.list.deleteConfirm') : t('desktop.list.delete')),
                h('button', { class: 'btn btn-primary', onclick: closeDialog }, t('common.close')),
            ], { className: 'list-settings-dialog' })
            if (dialogDom.shouldEnter(kind)) queueMicrotask(() => nameInput.focus())
        } else if (kind === 'list-settings') {
            const registry = reduceRegistry(state.items)
            const entry = registry.lists.find((l) => l.id === ui.dialog.listId)
            if (!entry) { closeDialog(); return }
            const listId = ui.dialog.listId
            const nameInput = h('input', { id: 'list-settings-name', class: 'input', value: entry.name, 'aria-label': t('desktop.list.rename') })
            const commitName = () => { const nv = nameInput.value.trim(); if (nv && nv !== entry.name) actions.renameList(listId, nv) }
            nameInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') { commitName(); closeDialog() } })
            nameInput.addEventListener('blur', commitName)
            // Every list belongs to a group; offer existing groups (always with
            // "general") and preselect the current one, defaulting to general.
            const groupChoices = [...registry.groups]
            if (!groupChoices.some((g) => g.id === GENERAL_GROUP_ID)) groupChoices.unshift({ id: GENERAL_GROUP_ID, name: t('desktop.group.general') })
            const currentGroupId = groupChoices.some((g) => g.id === entry.groupId) ? entry.groupId : GENERAL_GROUP_ID
            const groupSelect = h('select', {
                id: 'list-settings-group', class: 'prop-select',
                'aria-label': t('desktop.list.group'),
                onchange: (event) => actions.moveListToGroup(listId, event.target.value || GENERAL_GROUP_ID),
            }, ...groupChoices.map((g) => {
                const opt = h('option', { value: g.id }, g.name)
                if (g.id === currentGroupId) opt.setAttribute('selected', 'selected')
                return opt
            }))
            content = dialogFrame(entry.name || t('desktop.list.settings'), [
                h('h3', { class: 'category-heading label-sm' }, t('desktop.list.rename')),
                nameInput,
                h('h3', { class: 'category-heading label-sm' }, t('desktop.list.group')),
                groupSelect,
                listIdentityBlock(listId, entry.type),
                listMembersBlock(listId),
                listSharingBlock(!!entry.baseKey, () => { closeDialog(); actions.shareList(listId) }, listId === DEFAULT_LIST_ID),
                listRigorToggle(listId, entry.type),
                valueReturnToggleRow(listId, entry.type),
            ], [
                h('button', {
                    class: 'btn btn-danger',
                    onclick: () => {
                        if (!ui.dialog.confirmDelete) { ui.dialog.confirmDelete = true; renderAll(); return }
                        actions.deleteList(listId)
                        closeDialog()
                    },
                }, ui.dialog.confirmDelete ? t('desktop.list.deleteConfirm') : t('desktop.list.delete')),
                h('button', { class: 'btn btn-primary', onclick: closeDialog }, t('common.close')),
            ], { className: 'list-settings-dialog' })
            if (dialogDom.shouldEnter(kind)) queueMicrotask(() => nameInput.focus())
        } else if (kind === 'group-settings') {
            const group = reduceRegistry(state.items).groups.find((g) => g.id === ui.dialog.groupId)
            if (!group) { closeDialog(); return }
            const groupId = ui.dialog.groupId
            // "general" is the mandated default home — renamable, but not deletable.
            const isGeneral = groupId === GENERAL_GROUP_ID
            const nameInput = h('input', { class: 'input', value: group.name })
            const commitName = () => { const nv = nameInput.value.trim(); if (nv && nv !== group.name) actions.renameGroup(groupId, nv) }
            nameInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') { commitName(); closeDialog() } })
            nameInput.addEventListener('blur', commitName)
            content = dialogFrame(group.name || t('desktop.group.settings'), [
                h('h3', { class: 'category-heading label-sm' }, t('desktop.list.rename')),
                nameInput,
                isGeneral ? h('p', { class: 'label-md', style: 'color: var(--secondary);' }, t('desktop.group.generalNote')) : null,
                h('div', { class: 'choice-row' },
                    h('button', { class: 'btn btn-secondary', onclick: () => openDialog({ kind: 'list-create', groupId }) }, t('desktop.group.newList')),
                ),
            ], [
                isGeneral ? null : h('button', {
                    class: 'btn btn-danger',
                    onclick: () => {
                        if (!ui.dialog.confirmDelete) { ui.dialog.confirmDelete = true; renderAll(); return }
                        actions.deleteGroup(groupId)
                        closeDialog()
                    },
                }, ui.dialog.confirmDelete ? t('desktop.group.deleteConfirm') : t('desktop.group.delete')),
                h('button', { class: 'btn btn-primary', onclick: closeDialog }, t('common.close')),
            ])
            queueMicrotask(() => nameInput.focus())
        } else if (kind === 'member-remove') {
            content = dialogFrame(t('members.confirmRemove.title'), [
                h('p', { class: 'dialog-body' }, t('members.confirmRemove.message')),
            ], [
                h('button', { class: 'btn btn-secondary', onclick: closeDialog }, t('common.cancel')),
                h('button', { class: 'btn btn-danger', onclick: () => actions.confirmRemoveMember(ui.dialog.member) }, t('common.remove')),
            ], { trust: true })
        } else if (kind === 'compaction-confirm') {
            content = dialogFrame(t('compaction.title'), [
                h('p', { class: 'dialog-body warning' }, t('compaction.confirm')),
            ], [
                h('button', { class: 'btn btn-secondary', onclick: closeDialog }, t('common.cancel')),
                h('button', { class: 'btn btn-danger', onclick: () => { void runCompaction() } }, t('compaction.action')),
            ], { trust: true })
        } else if (kind === 'server-shutdown') {
            content = dialogFrame(t('desktop.servers.shutdown'), [
                h('p', { class: 'dialog-body warning' }, t('desktop.servers.shutdownConfirm', { name: ui.dialog.serverName })),
            ], [
                h('button', { class: 'btn btn-secondary', onclick: closeDialog }, t('common.cancel')),
                h('button', { class: 'btn btn-danger', onclick: () => shutdownServer(ui.dialog.serverKey) }, t('desktop.servers.shutdown')),
            ], { trust: true })
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
            ], { trust: true })
        } else if (kind === 'devices') {
            // Who is on this list — names + roles + copyable fingerprint, and per
            // device its live presence (online-now / last-seen / last-ping / avg
            // online, from the synced heartbeat channel) plus the connected count.
            const writers = state.roster?.writers ?? []
            const deviceRows = writers.length === 0
                ? [h('p', { class: 'dialog-body', style: 'color: var(--secondary);' }, t('desktop.peers.none'))]
                : writers.map((w) => {
                    const pd = peerDisplay(w.writerKey)
                    const meta = presenceMeta(w.writerKey)
                    return h('div', { class: 'device-row' },
                        presenceDot(w.writerKey),
                        h('span', { class: `ticket-avatar${pd.isSelf || pd.isOwner ? ' is-self' : ''}`, title: pd.title }, pd.initials),
                        h('div', { class: 'device-main' },
                            h('span', { class: 'device-name' }, pd.name || (pd.isSelf ? t('members.role.self') : pd.short)),
                            fingerprintChip(w.writerKey),
                            meta ? h('span', { class: 'presence-meta' }, meta) : null,
                        ),
                        presenceStatus(w.writerKey),
                        h('span', { class: `role-chip${pd.isOwner ? ' owner' : ''}` },
                            pd.isOwner ? t('members.role.owner') : pd.isSelf ? t('members.role.self') : t('members.role.member')),
                    )
                })
            content = dialogFrame(t('desktop.devices.title'), [
                h('div', { class: 'summary-bar label-md', style: 'margin-bottom: 1rem;' },
                    h('span', { class: `dot ${beaconState(state)}` }),
                    h('span', {}, state.peerCount === 0 ? t('desktop.peers.none') : t('desktop.peers.connected', { count: state.peerCount })),
                ),
                h('div', { class: 'device-rows' }, ...deviceRows),
            ], [
                h('button', { class: 'btn btn-primary', onclick: closeDialog }, t('common.close')),
            ])
        } else if (kind === 'shortcuts') {
            const rows = [
                ['N', t('desktop.shortcuts.addItem')],
                ['G', t('desktop.shortcuts.toggleView')],
                ['[ ]', t('desktop.shortcuts.switchList')],
                ['↑ ↓', t('desktop.shortcuts.navigate')],
                ['← →', t('desktop.shortcuts.boardColumn')],
                ['⇧ ← →', t('desktop.shortcuts.boardMove')],
                ['↵', t('desktop.shortcuts.openTicket')],
                ['Space', t('desktop.shortcuts.toggleDone')],
                ['F', t('desktop.shortcuts.flag')],
                ['⇧ F', t('desktop.shortcuts.flagFor')],
                ['I', t('inspector.toggle')],
                ['Delete', t('desktop.shortcuts.deleteItem')],
                ['⌘Z', t('desktop.shortcuts.undo')],
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
        } else if (kind === 'item-move') {
            const item = ui.dialog.item
            const rail = buildRail(state)
            const isCurrent = (s) => s.listId === item.listId && surfaceForType(s.type) === surfaceForType(item.listType)
            const typeGlyph = (type) => tablerIcon(isBoardType(type) ? 'layout-columns' : isTodoType(type) ? 'checklist' : isNotesType(type) ? 'notes' : 'basket', { size: 16 })
            const dests = rail.groups
                .map((g) => ({ name: g.name, surfaces: g.surfaces.filter((s) => !isCurrent(s)) }))
                .filter((g) => g.surfaces.length)
            const destButton = (s) => h('button', {
                class: 'btn btn-secondary move-dest',
                style: 'display:flex; align-items:center; gap:8px; width:100%; justify-content:flex-start; margin:2px 0;',
                onclick: () => { closeDialog(); actions.moveItem(item, s.listId, s.type) },
            }, typeGlyph(s.type), h('span', {}, s.name))
            const body = dests.length
                ? dests.map((g) => h('div', { class: 'move-group', style: 'margin-bottom:10px;' },
                    h('h3', { class: 'label-sm', style: 'color: var(--secondary); margin:6px 0;' }, g.name),
                    ...g.surfaces.map(destButton)))
                : [h('p', { class: 'dialog-body' }, t('move.empty'))]
            content = dialogFrame(t('move.title'), [
                h('p', { class: 'dialog-body', style: 'color: var(--secondary);' }, t('move.subtitle', { text: item.text })),
                ...body,
            ], [
                h('button', { class: 'btn btn-secondary', onclick: closeDialog }, t('common.cancel')),
            ])
        } else if (kind === 'add-ticket') {
            const config = selectBoardConfig(listAccess(state, ui.dialog.targetListId || ui.activeListId))
            const rigorOn = config.rigorOn
            const draft = ui.dialog.draft
            // Two modes share this panel. `draftId` is the LIVE one: the row
            // already exists and every field autosaves onto it. Without it this
            // is the promote-into-board form (moveItem opens it when an existing
            // grocery/to-do item is dragged onto a board and the rigor gate needs
            // filling), where there is no board row yet and nothing to save to —
            // that path still collects the fields and submits once.
            const draftId = ui.dialog.draftId ?? null
            const live = draftId != null
            // Value-return rating (mandatory when the destination surface has it on).
            const vListId = ui.dialog.moveFrom ? ui.dialog.targetListId : ui.activeListId
            const vType = ui.dialog.moveFrom ? ui.dialog.targetListType : ui.activeType
            const valueOn = isValueSurface(vListId, vType)
            const touched = () => { if (live) scheduleTicketDraftSave(draftId, draft, valueOn) }

            const descInput = h('input', { class: 'input', value: draft.description, placeholder: t('ticket.field.descriptionPlaceholder'), oninput: (event) => { draft.description = event.target.value; touched() } })
            const hoursInput = h('input', { class: 'input', type: 'number', min: '0.25', step: '0.25', style: 'max-width: 130px;', value: draft.hours, placeholder: '6', oninput: (event) => { draft.hours = event.target.value; touched() } })
            const cxReadout = h('span', { class: 'complexity-readout label-md' }, `${draft.complexity}%`)
            const cxInput = h('input', { type: 'range', min: '1', max: '100', value: String(draft.complexity), class: 'complexity-slider', oninput: (event) => { draft.complexity = Number(event.target.value); cxReadout.textContent = `${draft.complexity}%`; touched() } })
            if (draft.valueRate === undefined) draft.valueRate = null
            if (draft.delayRate === undefined) draft.delayRate = null
            // Value + delay capture as sliders (1–10), mirroring the detail-drawer
            // rate sliders and the creation complexity slider. The readout shows
            // "—" until the user moves the thumb, so an untouched rate stays null
            // and validateValueDraft still enforces a conscious choice.
            const rateSliderField = (key) => {
                const readout = h('span', { class: 'complexity-readout label-md' }, draft[key] != null ? String(draft[key]) : '—')
                const slider = h('input', {
                    type: 'range', min: String(VALUE_MIN), max: String(VALUE_MAX), step: '1', class: 'rate-slider',
                    value: draft[key] != null ? String(draft[key]) : String(VALUE_MIN),
                    oninput: (event) => { draft[key] = clampRate(Number(event.target.value)); readout.textContent = String(draft[key]); touched() },
                })
                return { slider, readout }
            }
            const valField = rateSliderField('valueRate')
            const delField = rateSliderField('delayRate')
            const taskRows = draft.tasks.map((val, index) => h('div', { class: 'rigor-task-row' },
                h('input', { class: 'input', value: val, placeholder: t('ticket.field.taskPlaceholder'), oninput: (event) => { draft.tasks[index] = event.target.value; touched() } }),
                h('button', { class: 'btn btn-secondary btn-icon', 'aria-label': t('common.remove'), onclick: () => { draft.tasks.splice(index, 1); if (!draft.tasks.length) draft.tasks.push(''); touched(); renderAll() } }, tablerIcon('x', { size: 14 })),
            ))
            const missingNow = () => ticketDraftMissing(draft, config, valueOn)
            const shakeMissing = (missing) => {
                store.pushNotice(t('ticket.create.missing'), 'error')
                if (missing.includes('description')) shake(descInput)
                if (missing.includes('hours')) shake(hoursInput)
                if (missing.includes('value')) shake(valField.slider)
                if (missing.includes('delay')) shake(delField.slider)
            }
            const submit = () => {
                const missing = missingNow()
                if (missing.length) { shakeMissing(missing); return }
                // The live panel needs no write here: closeDialog runs the
                // onClose settlement, which flushes the pending edit AND clears
                // the draft mark in one append (see settleTicketDraft).
                if (live) { closeDialog(); return }
                const desc = draft.description.trim()
                const checklist = ticketDraftChecklist(draft)
                const hours = Number(draft.hours)
                const complexity = Number(draft.complexity)
                const valueFields = valueOn ? { valueRate: draft.valueRate, delayRate: draft.delayRate } : {}
                // Promote-into-board move: relocate the existing item (id
                // preserved) and supply the rigor fields the form collected.
                markLocalId(ui.dialog.moveFrom.id)
                send(RPC_MOVE, {
                    item: ui.dialog.moveFrom,
                    targetListId: ui.dialog.targetListId,
                    targetListType: BOARD_WRITE_TYPE,
                    fields: { status: 'todo', description: desc, checklist, estimatedHours: hours, estimatedComplexity: complexity, ...valueFields },
                })
                closeDialog()
            }
            // Throwing the row away is now an explicit act, because closing the
            // panel deliberately does NOT: that is the whole point of the change.
            const discard = () => {
                cancelTicketDraftSave()
                const row = store.getState().items.find((it) => it && it.id === draftId)
                if (row) { markLocalId(draftId); send(RPC_DELETE, { item: row }) }
                if (ui.dialog) ui.dialog.onClose = null
                closeDialog()
            }
            content = dialogFrame(live ? t('ticket.create.liveTitle') : t('ticket.create.title'), [
                rigorOn ? h('div', { class: 'rigor-badge' }, tablerIcon('checklist', { size: 13 }), t('ticket.create.rigorBadge')) : null,
                rigorOn ? h('p', { class: 'dialog-body', style: 'color: var(--secondary);' }, t('ticket.create.rigorHint')) : null,
                live ? h('p', { class: 'dialog-body draft-hint', style: 'color: var(--secondary);' }, tablerIcon('device-floppy', { size: 13 }), t('ticket.create.autosaveHint')) : null,
                fieldLabel(t('ticket.field.description'), rigorOn),
                descInput,
                fieldLabel(t('ticket.field.tasks'), rigorOn),
                h('div', { class: 'rigor-tasks' }, ...taskRows),
                h('button', { class: 'btn btn-secondary add-task', onclick: () => { draft.tasks.push(''); renderAll() } }, tablerIcon('plus', { size: 14 }), t('ticket.field.addTask')),
                h('div', { class: 'rigor-2col' },
                    h('div', {}, fieldLabel(t('ticket.field.hours'), rigorOn), hoursInput),
                    h('div', {}, fieldLabel(t('ticket.field.complexity'), rigorOn), h('div', { class: 'complexity-row' }, cxInput, cxReadout)),
                ),
                valueOn ? h('div', { class: 'rigor-2col' },
                    h('div', {}, fieldLabel(t('value.value'), true), h('div', { class: 'value-input-row' }, tablerIcon('coins', { size: 14 }), valField.slider, valField.readout)),
                    h('div', {}, fieldLabel(t('value.delay'), true), h('div', { class: 'value-input-row' }, tablerIcon('hourglass', { size: 14 }), delField.slider, delField.readout)),
                ) : null,
                rigorOn ? h('p', { class: 'label-md', style: 'color: var(--secondary);' }, t('ticket.rigor.ownerNote')) : null,
            ], [
                live
                    ? h('button', { class: 'btn btn-secondary btn-danger-text', onclick: discard }, t('ticket.create.discard'))
                    : h('button', { class: 'btn btn-secondary', onclick: closeDialog }, t('common.cancel')),
                h('button', { class: 'btn btn-primary', onclick: submit }, live ? t('ticket.create.done') : t('ticket.create.submit')),
            ])
            // Autofocus belongs to the OPEN, not to every render. Each autosave
            // echoes back and rebuilds this dialog; without the guard the caret
            // was yanked out of whatever field was being typed into and back to
            // the description on every save.
            if (dialogDom.shouldEnter(kind)) queueMicrotask(() => descInput.focus())
        } else if (kind === 'value-rate') {
            // Collect the mandatory value + delay rates for a to-do add, or edit
            // them on an existing item. Shared between the add-bar gate and the
            // per-row edit affordance.
            const d = ui.dialog
            const rateField = (key, label, icon) => {
                const inp = h('input', { class: 'input', type: 'number', min: String(VALUE_MIN), max: String(VALUE_MAX), style: 'max-width: 130px;', placeholder: `${VALUE_MIN}–${VALUE_MAX}`, oninput: (event) => { d[key] = event.target.value === '' ? null : clampRate(Number(event.target.value)) } })
                inp.value = d[key] != null ? String(d[key]) : ''
                return { inp, row: h('div', {}, fieldLabel(label, true), h('div', { class: 'value-input-row' }, tablerIcon(icon, { size: 14 }), inp)) }
            }
            const valF = rateField('valueRate', t('value.value'), 'coins')
            const delF = rateField('delayRate', t('value.delay'), 'hourglass')
            const submit = () => {
                const check = validateValueDraft({ valueRate: d.valueRate, delayRate: d.delayRate })
                if (!check.ok) {
                    store.pushNotice(t('value.rate.missing'), 'error')
                    if (check.missing.includes('value')) shake(valF.inp)
                    if (check.missing.includes('delay')) shake(delF.inp)
                    return
                }
                if (d.mode === 'edit' && d.item) {
                    actions.updateTicket(d.item, { valueRate: d.valueRate, delayRate: d.delayRate })
                } else {
                    actions.addItem(d.text, { valueRate: d.valueRate, delayRate: d.delayRate })
                }
                closeDialog()
            }
            content = dialogFrame(t('value.addRate'), [
                d.text ? h('p', { class: 'body-md' }, d.text) : null,
                h('div', { class: 'rigor-2col' }, valF.row, delF.row),
            ], [
                h('button', { class: 'btn btn-secondary', onclick: closeDialog }, t('common.cancel')),
                h('button', { class: 'btn btn-primary', onclick: submit }, d.mode === 'edit' ? t('common.save') : t('value.add')),
            ])
            queueMicrotask(() => valF.inp.focus())
        }

        // Info disclosures stay open across background syncs without rebuilding
        // the dialog on click (which would throw keyboard focus away).
        function listInfo(key, label, children) {
            const expanded = !!ui.dialog[key]
            const panel = h('div', { id: `list-info-${key}`, class: 'list-info-panel', hidden: expanded ? null : '' }, ...children)
            const button = h('button', {
                id: `list-info-button-${key}`, type: 'button', class: 'btn btn-secondary list-info-button',
                'aria-expanded': String(expanded), 'aria-controls': `list-info-${key}`,
                onclick: () => {
                    const open = !ui.dialog[key]
                    ui.dialog[key] = open
                    panel.hidden = !open
                    button.setAttribute('aria-expanded', String(open))
                },
            }, tablerIcon('info-circle', { size: 18 }), label)
            return h('section', { class: 'list-info' }, button, panel)
        }

        function listIdentityBlock(listId, listType) {
            const row = (label, value) => h('div', { class: 'list-identity-row' }, h('dt', {}, label), h('dd', {}, value || '—'))
            const access = listAccess(state, listId)
            return listInfo('identityOpen', t('list.identity.title'), [
                h('dl', { class: 'list-identity' },
                    row(t('list.identity.project'), state.baseId),
                    row(t('list.identity.list'), listId),
                    row(t('list.identity.surface'), `${listId}:${listType || DEFAULT_LIST_TYPE}`),
                    row(t('list.identity.epoch'), String(access.roster?.currentEpoch ?? (access.baseKey ? null : state.epoch) ?? '—')),
                ),
            ])
        }

        function listMembersBlock(listId) {
            const access = listAccess(state, listId)
            const members = access.roster?.writers || []
            return h('section', { class: 'list-members' },
                h('h3', { class: 'category-heading label-sm' }, t('list.members.title')),
                h('p', { class: 'list-settings-hint' }, t(access.baseKey ? 'list.members.sharedHint' : 'list.members.projectHint')),
                members.length ? h('ul', { class: 'list-members-rows' }, ...members.map((member) => {
                    const name = peerLabelMap().get(member.writerKey)?.trim() || 'anonymous'
                    return h('li', { class: 'list-member' },
                        h('div', { class: 'list-member-identity' },
                            h('span', { class: 'list-member-name' }, name),
                            fingerprintChip(member.writerKey),
                        ),
                        h('span', { class: 'role-chip' }, t(member.isSelf ? 'members.role.self' : member.isOwner ? 'members.role.owner' : 'members.role.member')),
                    )
                })) : h('p', { class: 'list-settings-hint' }, t(access.roster ? 'members.subtitle.none' : 'list.members.unavailable')),
            )
        }

        function listSharingBlock(shared, onShare, blocked = false) {
            return h('section', { class: 'list-sharing' },
                listInfo('sharingOpen', t('list.sharing.info'), [
                    h('h3', { class: 'category-heading label-sm' }, t('shareList.title')),
                    h('p', { class: 'list-settings-hint' }, blocked ? t('shareList.builtinBlocked') : `${shared ? t('shareList.shared') + ' — ' : ''}${t('share.list.hint')}`),
                ]),
                blocked ? null : h('button', { type: 'button', class: 'btn btn-secondary', onclick: onShare },
                    tablerIcon('share', { size: 16 }), t(shared ? 'shareList.showInvite' : 'shareList.button')),
            )
        }

        function listRigorToggle(listId, type) {
            if (!isBoardType(type)) return null
            const access = listAccess(state, listId)
            const config = selectBoardConfig(access)
            const canEdit = !!access.boardConfig && !!access.canAdminister
            const hintId = 'list-rigor-hint'
            return h('section', { class: 'list-rigor' },
                h('div', { class: 'switch-row' },
                    h('div', { class: 'switch-text' },
                        h('span', { id: 'list-rigor-label', class: 'switch-title label-sm' }, t('settings.rigor.label')),
                        h('p', { id: hintId, class: 'list-settings-hint' }, t(!access.boardConfig ? 'list.members.unavailable' : canEdit ? 'settings.rigor.ownerHelp' : 'settings.rigor.readonlyHelp')),
                        !access.baseKey ? h('p', { class: 'list-settings-hint' }, t('list.rigor.projectHint')) : null,
                    ),
                    h('button', {
                        id: 'list-rigor-switch', type: 'button', class: 'list-rigor-switch',
                        role: 'switch', 'aria-checked': String(config.rigorOn), 'aria-labelledby': 'list-rigor-label', 'aria-describedby': hintId,
                        disabled: canEdit ? null : '',
                        onclick: () => actions.setRigor(!config.rigorOn, listId),
                    }, h('span', { class: `switch${config.rigorOn ? ' on' : ''}`, 'aria-hidden': 'true' }, h('span', { class: 'switch-knob' }))),
                ),
            )
        }

        // Capture BEFORE the swap, restore AFTER it — the whole fix is that order.
        // The DOM subtree is still rebuilt for fresh state, but the entrance
        // animation belongs only to a real open. Replaying it on every store
        // update made idle dialogs visibly fade/shift as though they flickered.
        const snapshot = dialogDom.capture(dialogHost, kind)
        const enterClass = dialogDom.shouldEnter(kind) ? ' enter' : ''
        replaceChildren(dialogHost,
            h('div', { class: `dialog-backdrop${enterClass}`, onclick: (event) => { if (event.target === event.currentTarget) closeDialog() } }, content),
        )
        dialogDom.commit(kind)
        dialogDom.restore(dialogHost, snapshot)
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

    function dialogFrame(title, body, dialogActions, opts = {}) {
        const t = locale.i18n.t.bind(locale.i18n)
        // The trust register (opts.trust): irreversible surfaces — join (replaces
        // your base), member-remove, storage-reset, server-shutdown — render on
        // the inverse surface with a danger square marker, so they feel like a
        // mode, not an ordinary dialog. One pattern, reused per kind.
        return h('div', { class: `dialog${opts.trust ? ' trust-dialog' : ''}${opts.className ? ` ${opts.className}` : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
            opts.trust
                ? h('div', { class: 'trust-marker' }, h('span', { class: 'trust-square', 'aria-hidden': 'true' }), h('span', { class: 'label-sm' }, t('trust.irreversible')))
                : null,
            h('h2', { class: 'headline-sm' }, title),
            h('div', { class: 'dialog-body body-md' }, ...body),
            h('div', { class: 'dialog-actions' }, ...dialogActions.filter(Boolean)),
        )
    }

    // Redux Toolkit freezes projected state in development (and may do so in
    // packaged builds), so timer bookkeeping must stay renderer-local. Writing
    // `_timed` onto a notice used to throw on the first toast and abort every
    // later store-driven render, making successful mutations appear inert.
    const timedNoticeIds = new Set()
    function renderNotices(state) {
        // Persistent write-block banner: pure projection of state.writeBlock
        // (set on the backend's not-writable / sync-stalled refusal messages,
        // cleared when a write succeeds). Unlike toasts it never times out —
        // "your changes aren't being saved" must stay visible while true.
        const writeBlockBanner = state.writeBlock
            ? h('div', { class: 'notice error', dataset: { writeBlock: state.writeBlock } },
                locale.i18n.t(state.writeBlock === 'not-writable'
                    ? 'main.notification.writeNotWritable'
                    : state.writeBlock === 'epoch-key-stale'
                        ? 'main.notification.writeEpochStale'
                        : state.writeBlock === 'backend-unresponsive'
                            ? 'main.notification.writeBackendUnresponsive'
                            : state.writeBlock === 'storage-fenced'
                                ? 'main.notification.writeStorageFenced'
                                : state.writeBlock === 'write-refused'
                                    ? 'main.notification.writeRefused'
                                    : state.writeBlock === 'write-needs-decision'
                                        ? 'main.notification.writeNeedsDecision'
                                        : 'main.notification.writeSyncStalled'))
            : null
        const updateBanner = ui.updateReady
            ? h('div', { class: 'notice update-ready', dataset: { updateReady: 'true' } },
                h('span', {}, locale.i18n.t(ui.updateRestartFailed
                    ? 'desktop.update.restartFailed'
                    : 'desktop.update.ready')),
                h('button', {
                    class: 'notice-action',
                    type: 'button',
                    disabled: ui.updateRestarting ? 'true' : null,
                    onclick: async () => {
                        if (ui.updateRestarting) return
                        ui.updateRestarting = true
                        ui.updateRestartFailed = false
                        renderNotices(store.getState())
                        try {
                            await appUpdates.restart()
                        } catch {
                            ui.updateRestarting = false
                            ui.updateRestartFailed = true
                            renderNotices(store.getState())
                        }
                    },
                }, locale.i18n.t(ui.updateRestarting
                    ? 'desktop.update.restarting'
                    : 'desktop.update.restart')),
            )
            : null
        replaceChildren(noticesHost,
            ...(writeBlockBanner ? [writeBlockBanner] : []),
            ...(updateBanner ? [updateBanner] : []),
            ...state.notices.map((notice) => h('div', {
                class: `notice ${notice.tone}`,
                dataset: { noticeId: String(notice.id) },
            }, notice.text)),
        )
        for (const notice of state.notices) {
            if (timedNoticeIds.has(notice.id)) continue
            timedNoticeIds.add(notice.id)
            setTimeout(() => {
                // Fade out in place, then drop from the store.
                noticesHost.querySelector(`[data-notice-id="${notice.id}"]`)?.classList.add('leaving')
                setTimeout(() => {
                    timedNoticeIds.delete(notice.id)
                    store.dismissNotice(notice.id)
                }, reduceMotion() ? 0 : NOTICE_LEAVE_MS)
            }, NOTICE_TTL_MS)
        }
    }

    function preferencesToggle(key) {
        store.setPreferences({ [key]: !store.getState().preferences[key] })
    }

    // --- keyboard-first actions ----------------------------------------------
    root.ownerDocument.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            if (ui.dialog) { closeDialog(); return }
            if (ui.blockMenu) { actions.closeBlockMenu(); return }
            if (ui.inspectorItemId) { actions.closeInspector(); return }
            if (ui.ticketDocId || ui.selectedTicketId) { actions.closeTicket(); return }
            return
        }
        // The loading pane owns the workspace until the join settles; it carries
        // its own Stop button (RPC_CANCEL_JOIN), so keyboard shortcuts stay out.
        // In particular, do not let the command palette start another join
        // behind it.
        if (store.getState().isJoining) return
        const commandPaletteKey = (event.metaKey || event.ctrlKey) && (event.key === 'k' || event.key === 'K')
        if (!shouldHandleAppShortcut({
            drawerOpen: mountedDrawerKind !== null,
            dialogOpen: !!ui.dialog,
            typingTarget: isTypingKeystroke(event, root.ownerDocument.activeElement),
            commandPaletteKey,
        })) return

        // ⌘K / Ctrl+K opens the command palette from anywhere except a drawer,
        // where the local editing surface owns the keyboard until Escape closes it.
        if (commandPaletteKey) {
            event.preventDefault()
            openDialog({ kind: 'command-palette' })
            return
        }

        // ⌘Z / Ctrl+Z undoes the last content change (delete / edit / toggle).
        // Deliberately BELOW the typing guard so native char-undo wins inside
        // inputs and the block editor — this only fires when focus isn't in a
        // field. ⇧ (redo) is reserved for a later ship; ignore it here.
        if ((event.metaKey || event.ctrlKey) && (event.key === 'z' || event.key === 'Z')) {
            if (event.shiftKey) return
            event.preventDefault()
            undoLast()
            return
        }

        if (event.key === 'n' || event.key === '/') {
            event.preventDefault()
            // The notes surface has no add bar — a note is a document, not a
            // row typed into a field — so N makes one and opens it instead.
            if (ui.view === 'notes' && ui.activeListId != null) actions.newNote()
            else actions.summonAddBar()
        } else if (event.key === 'g') {
            // Grid view exists only on the grocery surface; ignore elsewhere.
            if (ui.view === 'lists') preferencesToggle('isGridView')
        } else if (event.key === 't') {
            actions.cycleTheme()
        } else if (event.key === 'h') {
            actions.toggleHints()
        } else if (event.key === '?') {
            openDialog({ kind: 'shortcuts' })
        } else if (event.key === '[' || event.key === ']') {
            // Move between rail surfaces in display order.
            event.preventDefault()
            const all = allSurfaces(buildRail(store.getState()))
            const i = all.findIndex(surfaceActive)
            const next = all[i + (event.key === ']' ? 1 : -1)]
            if (next) selectSurface(store.getState(), next)
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            // On a board this walks DOM order, which is column by column: ↓ off
            // the bottom of a column lands at the top of the next one. ←/→
            // below is what moves across columns deliberately.
            const rows = [...root.querySelectorAll('[data-item-id]')]
            if (rows.length === 0) return
            const index = rows.findIndex((row) => row.dataset.itemId === ui.focusedItemId)
            const next = event.key === 'ArrowDown'
                ? rows[Math.min(rows.length - 1, index + 1)]
                : rows[Math.max(0, index <= 0 ? 0 : index - 1)]
            next?.focus()
        } else if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && ui.view === 'board') {
            // ←/→ walks the columns; ⇧←/→ takes the focused ticket with it.
            // Status was mouse-only until now: there was no keyboard way to
            // move a ticket across the board at all.
            const state = store.getState()
            const item = state.items.find((entry) => entry && entry.id === ui.focusedItemId)
            if (!item) return
            event.preventDefault()
            const states = selectBoardConfig(listAccess(state, item.listId)).states
            const step = event.key === 'ArrowRight' ? 1 : -1
            const from = Math.max(0, states.findIndex((s) => s.id === (item.status || states[0]?.id)))
            if (event.shiftKey) {
                const target = states[from + step]
                if (target) actions.moveTicket(item, target.id)
                return
            }
            // Plain arrow moves FOCUS, so it skips columns with nothing to
            // focus rather than stalling on the first empty one.
            for (let i = from + step; i >= 0 && i < states.length; i += step) {
                const card = root.querySelector(`.board-column[data-status="${states[i].id}"] .ticket-card`)
                if (card) { card.focus(); return }
            }
        } else if (event.key === 'f' || event.key === 'F') {
            // Flag the focused item into the day-plan. Arrows only move DOM focus,
            // so resolve the item object from the store. Plain F = today, Shift+F =
            // pick a day. Same handlers as the row flag / flag-more buttons.
            const item = store.getState().items.find((it) => it.id === ui.focusedItemId)
            if (!item) return
            event.preventDefault()
            if (event.shiftKey) openDialog({ kind: 'plan-day', item })
            else actions.toggleItemPlan(item)
        } else if (event.key === 'i' || event.key === 'I') {
            // Toggle the Inspector for the focused grocery/todo item.
            if (ui.view !== 'lists' && ui.view !== 'todo') return
            if (!ui.focusedItemId) return
            event.preventDefault()
            actions.toggleInspector(ui.focusedItemId)
        }
    })

    // --- render loop ----------------------------------------------------------
    // Set of plan refs ('i:listId::itemId' / 'l:listId::type') with a live day,
    // recomputed once per render so item rows can show their flag state cheaply.
    let plannedRefs = new Set()
    // Map<surfaceKey, true> of surfaces with the value-return property enabled,
    // recomputed each render (like plannedRefs) so the gating + badges read a
    // single snapshot rather than re-reducing per item.
    let valueSurfaces = new Map()
    // Undo history is per-base: a reset / join (synced flips false) invalidates
    // every captured inverse, which may point at items that no longer exist.
    let lastSynced = null
    // A failed join used to leave nothing behind but one diagnostics line, so
    // three people on 4G got a spinner and then silence. Say what happened,
    // once per failure, resolved from the machine-readable reason — never from
    // the backend's untranslated Error message.
    let noticedJoinError = null
    function surfaceJoinError(state) {
        const failure = state.joinError
        if (!failure) {
            noticedJoinError = null
            return
        }
        // Identity, not reason: two consecutive timeouts are two failures and
        // the second one deserves to be seen.
        if (failure === noticedJoinError) return
        noticedJoinError = failure
        // Deferred: pushNotice dispatches, and dispatching from inside renderAll
        // would re-enter renderAll while this pass is still building the DOM.
        queueMicrotask(() => store.pushNotice(locale.i18n.t(joinErrorKey(failure.reason)), 'error'))
    }

    function renderAll() {
        const state = store.getState()
        if (state.synced === false && lastSynced !== false) {
            ui.undoStack.length = 0
            pendingBlockWrites.clear()
            blockWriteGeneration++
        }
        lastSynced = state.synced
        plannedRefs = new Set(reducePlan(state.items).keys())
        valueSurfaces = reduceValueReturn(state.items)
        // Advertise this device's name once its writer key is known (roster).
        maybeAssertDeviceName()
        // Republish any localStorage-only built-in group placement to the synced
        // channel, once, after the base is writable.
        migrateBuiltinGroups()
        // Materialize the mandated default "general" group once we're writable.
        maybeEnsureGeneralGroup()
        surfaceJoinError(state)
        // If anything inside the drawer/inspector holds focus (a button as much
        // as a field), don't let the row focus-restore below yank focus (and the
        // scroll position) back to the list row on a background re-render.
        const keepDrawerFocus = drawerHost.contains(main.ownerDocument.activeElement)
        renderNav(state)
        renderMain(state)
        renderDrawerHost(state)
        renderHints(state)
        renderDialog(state)
        renderNotices(state)
        // Same rule for every OTHER field in the app — the add bar, an inline
        // rename in the rail, a dialog input, a block editor. Each of those
        // surfaces restores its own focus across a rebuild; the row restore runs
        // after all of them, so without this check it would take focus straight
        // back off the user mid-word. Read AFTER the renders: the field that
        // holds focus now is the rebuilt one, not the detached original.
        const keepFieldFocus = isTypingTarget(main.ownerDocument.activeElement)
        if (ui.focusedItemId && !ui.editingItemId && !keepDrawerFocus && !keepFieldFocus) {
            // preventScroll: re-rendering the list must never scroll it.
            root.querySelector(`[data-item-id="${CSS.escape(ui.focusedItemId)}"]`)?.focus?.({ preventScroll: true })
        }
        // Snapshot for the next render's motion diff (rowAnimationClass).
        prevItems = new Map(state.items.map((item) => [item.id, { isDone: !!item.isDone, text: item.text }]))
    }

    maybeSeedDeviceName()
    try {
        appUpdates?.subscribe?.(() => {
            ui.updateReady = true
            ui.updateRestartFailed = false
            renderAll()
        })
    } catch { /* update notifications are best-effort */ }
    store.subscribe(renderAll)
    renderAll()

    // Live-ish monitoring: while the Peers & Devices pane is open (which now
    // hosts the Servers section), re-poll paired servers every 20s. Silent so an
    // in-flight poll doesn't flicker the dots; the busy guard in refreshServer
    // prevents overlap. One interval for the app's lifetime — cheap when hidden.
    if (ownerControl && typeof setInterval === 'function') {
        setInterval(() => { if (ui.view === 'peers') refreshAllServers({ silent: true }) }, SERVERS_POLL_MS)
    }
    // Presence decays with wall-clock: a peer that stops beating must flip offline
    // as time passes, with no new event to drive a re-render. Re-render the peers
    // pane / devices dialog on a slow tick so online-now and "seen ago" stay live
    // while visible. Cheap and idle when neither surface is showing.
    if (typeof setInterval === 'function') {
        setInterval(() => {
            if (ui.view !== 'peers' && ui.dialog?.kind !== 'devices') return
            // Re-probe the transport while the pane that shows it is open, so the
            // diagnostics a user is staring at during a failed share are current.
            // Fired alongside the render rather than instead of it: the probe is
            // async and skips itself while one is in flight, and presence decay
            // still owes this tick a re-render either way.
            if (ui.view === 'peers') void refreshNetDiagnostics()
            renderAll()
        }, PRESENCE_TICK_MS)
        setInterval(() => {
            if (ui.view !== 'peers' && !['share', 'share-list'].includes(ui.dialog?.kind)) return
            renderAll()
        }, INVITE_TICK_MS)
    }
    return { renderAll, openDialog, closeDialog, actions }
}
