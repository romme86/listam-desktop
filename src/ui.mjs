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
} from '@listam/protocol'
import { groupByCategory, getDisplayCategoryName } from '@listam/grocery'
import {
    SERVICE_UUID,
    CHAR_CONFIG_UUID,
    CHAR_STATUS_UUID,
    buildProvisioningPayload,
    provisionLeaf,
} from '@listam/provisioning'
import { DEFAULT_LIST_ID, isTodoType, TODO_LIST_TYPE } from '@listam/domain/identity'
import { computeReorder, sortByOrder } from '@listam/domain/ordering'
import { isRegistryItem, reduceRegistry } from '@listam/domain/list-registry'
import {
    isLabelItem,
    surfaceLabelKey,
    buildSurfaceLabelItem,
    buildPeerLabelItem,
    buildBuiltinGroupItem,
    reduceSurfaceLabels,
    reducePeerLabels,
    reduceBuiltinGroups,
} from '@listam/domain/labels'
import {
    isPlanItem,
    reducePlan,
    groupPlanByDate,
    computePlanReorder,
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
} from './registry.mjs'
import { selectSummary, selectDoneItems } from './store.mjs'
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

// Grocery surfaces (the lists pane, its count, clear-done) operate on ordinary
// grocery list items only. Board tickets live on their own board, and to-do
// items are plain text with no grocery intelligence — both are excluded so they
// are never shown, counted, categorized, or cleared alongside groceries. The
// desktop has no dedicated to-do surface yet (the rail's "todo" entry is still
// "soon"), so to-do lists synced from mobile are simply not surfaced here rather
// than corrupting the grocery view with category grouping.
function isGroceryItem(item) {
    // Registry meta-items (listType 'registry') describe lists/groups, not
    // grocery entries — they share state.items but must never render as rows.
    // (Board/to-do are already excluded by type; registry is the one a bare
    // "not board, not todo" test would wrongly admit.)
    // Label meta-items (peer names, surface names) also share state.items but
    // live in their own listId buckets and must never render as grocery rows.
    return !!item && !isRegistryItem(item) && !isLabelItem(item) && !isPlanItem(item) && !isBoardType(item.listType) && !isTodoType(item.listType)
}

// The to-do surface: plain text items (isTodoType), the mirror of isGroceryItem
// for the grocery surface and isBoardType for the board.
function isTodoItem(item) {
    return !!item && isTodoType(item.listType)
}

// Locale-neutral formatters for the Servers monitoring pane. Bytes use binary
// units; durations collapse to the two coarsest non-zero parts.
function formatBytes(n) {
    const bytes = Number(n) || 0
    if (bytes < 1024) return `${bytes} B`
    const units = ['KB', 'MB', 'GB', 'TB']
    let value = bytes / 1024
    let unit = 0
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
    return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}
function formatAgo(ms) {
    const secs = Math.max(0, Math.round(Number(ms) / 1000))
    if (secs < 60) return `${secs}s`
    const mins = Math.round(secs / 60)
    if (mins < 60) return `${mins}m`
    const hrs = Math.round(mins / 60)
    if (hrs < 24) return `${hrs}h`
    return `${Math.round(hrs / 24)}d`
}
function formatUptime(ms) {
    const secs = Math.max(0, Math.floor(Number(ms) / 1000))
    const days = Math.floor(secs / 86400)
    const hrs = Math.floor((secs % 86400) / 3600)
    const mins = Math.floor((secs % 3600) / 60)
    if (days > 0) return `${days}d ${hrs}h`
    if (hrs > 0) return `${hrs}h ${mins}m`
    return `${mins}m`
}

export function mountApp({ root, store, client, locale, ownerControl = null, env = {} }) {
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
        // Plan row drag (reorder within a day / drop onto a day pill): { ref, fromDate }.
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
        // Per-paired-server monitoring state, keyed by serverPublicKeyHex:
        // { status, fetchedAt, error, busy, invite }. Populated by the Servers
        // pane's owner-control status queries; `undefined` means never fetched.
        servers: {},
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
        // Rail drag-and-drop: the list surface being dragged between groups.
        // { listId, type, builtin, fromGroupId } while a drag is in flight.
        railDrag: null,
        boardConfigRequested: false,
    }
    const now = env.now ?? (() => Date.now())
    // Block ids only need to be unique within a session; the renderer rebuilds
    // the DOM wholesale, so a monotonic counter mixed with the clock suffices.
    let blockIdSeq = 0
    const nextBlockId = () => `b-${now()}-${blockIdSeq++}`
    // Rigor-task ids follow the same session-unique scheme as block ids so a
    // task added post-creation never collides with a creation-time `task-N-…` id.
    let taskIdSeq = 0
    const nextTaskId = () => `task-${now()}-${taskIdSeq++}`
    // List/group ids double as the registry meta-item's id; clock + counter keeps
    // them unique across a session without coordinating with peers.
    let registryIdSeq = 0
    const nextListId = () => `list-${now()}-${registryIdSeq++}`
    const nextGroupId = () => `group-${now()}-${registryIdSeq++}`
    // The reduced registry derived from the synced meta-items in state.items.
    const currentRegistry = () => reduceRegistry(store.getState().items)

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
    const send = (command, payload) => Promise.resolve(client.send(command, payload)).catch(() => {
        store.pushNotice(locale.i18n.t('backend.startFailed'), 'error')
    })

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
        const signature = `${key} ${name}`
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
    // Unlike `send`, these need the worker's reply (the encrypted file or the
    // import outcome), so they call client.send directly and parse the JSON.
    async function backupRequest(command, payload) {
        const raw = await client.send(command, payload)
        try { return raw ? JSON.parse(raw) : null } catch { return null }
    }
    function backupErrorMessage(reason) {
        const t = locale.i18n.t.bind(locale.i18n)
        switch (reason) {
            case 'bad-password': return t('backup.error.badPassword')
            case 'invalid-file': return t('backup.error.invalidFile')
            case 'seed-incomplete': return t('backup.error.seedIncomplete')
            case 'not-writable': return t('backup.error.notWritable')
            case 'sync-stalled': return t('backup.error.syncStalled')
            default: return t('backup.error.generic')
        }
    }
    function backupFilename(kind) {
        const stamp = new Date().toISOString().slice(0, 10)
        return kind === 'seed' ? `listam-seed-${stamp}.listamseed` : `listam-backup-${stamp}.listam`
    }
    function downloadTextFile(filename, text) {
        const url = URL.createObjectURL(new Blob([text], { type: 'application/octet-stream' }))
        const anchor = h('a', { href: url, download: filename })
        document.body.append(anchor)
        anchor.click()
        anchor.remove()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
    }
    function pickBackupFile() {
        return new Promise((resolve) => {
            const input = h('input', {
                type: 'file',
                accept: '.listam,.listamseed,application/json,application/octet-stream',
                style: 'display:none',
            })
            input.addEventListener('change', () => {
                const file = input.files && input.files[0]
                if (!file) { input.remove(); resolve(null); return }
                const reader = new FileReader()
                reader.onload = () => { input.remove(); resolve(String(reader.result || '')) }
                reader.onerror = () => { input.remove(); resolve(null) }
                reader.readAsText(file)
            }, { once: true })
            document.body.append(input)
            input.click()
        })
    }
    async function startBackupImport() {
        const fileText = await pickBackupFile()
        if (fileText == null) return
        let fileKind = null
        try { fileKind = JSON.parse(fileText)?.kind } catch { /* shown as invalid on submit */ }
        openDialog({ kind: 'backup', mode: 'import', fileText, fileKind })
    }
    async function runBackupExport(mode, password) {
        const t = locale.i18n.t.bind(locale.i18n)
        closeDialog()
        store.pushNotice(t('backup.working'), 'info')
        const res = await backupRequest(mode === 'export-seed' ? RPC_EXPORT_SEED : RPC_EXPORT_DATA, { password })
        if (res?.ok && res.file) {
            downloadTextFile(backupFilename(res.kind), res.file)
            store.pushNotice(t('backup.exported'), 'success')
        } else {
            store.pushNotice(backupErrorMessage(res?.reason), 'error')
        }
    }
    async function runBackupImport(fileText, password) {
        const t = locale.i18n.t.bind(locale.i18n)
        closeDialog()
        store.pushNotice(t('backup.working'), 'info')
        const res = await backupRequest(RPC_IMPORT, { password, file: fileText })
        if (!res?.ok) { store.pushNotice(backupErrorMessage(res?.reason), 'error'); return }
        if (res.kind === 'seed') { store.pushNotice(t('backup.seedRestored'), 'success'); return }
        if (res.reason === 'not-writable') { store.pushNotice(t('backup.error.notWritable'), 'error'); return }
        store.pushNotice(t('backup.imported', { count: res.applied?.items ?? 0 }), 'success')
        if (res.applied?.boardConfigSkipped) store.pushNotice(t('backup.boardConfigSkipped'), 'info')
    }
    // --- automatic pre-join backups ---------------------------------------
    async function loadAutoBackups() {
        const res = await backupRequest(RPC_LIST_BACKUPS)
        ui.backups = (res && Array.isArray(res.backups)) ? res.backups : []
        ui.backupPasswordSet = !!(res && res.passwordSet)
        // The rolling scheduled-backup tiers (15m / 1d / 1w) ride along on the
        // same reply; null means the backend didn't report one yet.
        ui.backupSchedule = (res && res.schedule) ? res.schedule : null
        renderAll()
    }
    async function runSetBackupSchedule(enabled) {
        const res = await backupRequest(RPC_SET_BACKUP_SCHEDULE, { enabled })
        if (!res?.ok) { store.pushNotice(backupErrorMessage(res?.reason), 'error'); return }
        // Reuse the returned schedule when present; otherwise re-fetch so the
        // tier rows and toggle reflect the persisted on/off choice.
        if (res.schedule) { ui.backupSchedule = res.schedule; renderAll() }
        else loadAutoBackups()
    }
    async function runSetBackupPassword(current, next) {
        const t = locale.i18n.t.bind(locale.i18n)
        closeDialog()
        const res = await backupRequest(RPC_SET_BACKUP_PASSWORD, { current, next })
        if (!res?.ok) { store.pushNotice(backupErrorMessage(res?.reason), 'error'); return }
        store.pushNotice(t('backup.auto.passwordSaved'), 'success')
        loadAutoBackups()
    }
    async function runRestoreAutoBackup(file, password) {
        const t = locale.i18n.t.bind(locale.i18n)
        closeDialog()
        store.pushNotice(t('backup.working'), 'info')
        const res = await backupRequest(RPC_RESTORE_BACKUP, { file, password })
        if (!res?.ok) { store.pushNotice(backupErrorMessage(res?.reason), 'error'); return }
        store.pushNotice(t('backup.auto.restored', { count: res.applied?.items ?? 0 }), 'success')
        if (res.applied?.boardConfigSkipped) store.pushNotice(t('backup.boardConfigSkipped'), 'info')
        loadAutoBackups()
    }
    const actions = {
        addItem(text) {
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
            // A shared list's writes carry its baseKey so the backend routes them
            // to that base (UPDATE/DELETE/MOVE already carry it on the item).
            send(RPC_ADD, { text: trimmed, listId, listType: isTodo ? TODO_LIST_TYPE : undefined, baseKey: ui.activeBaseKey || undefined })
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
            const item = buildSurfaceLabelItem({ listId, type, name: (name ?? '').trim(), updatedAt: now() })
            markLocalId(item.id)
            send(RPC_UPDATE, { item })
        },
        // Delete a former built-in surface. With no registry meta-item to
        // tombstone, deletion (a) cascades away its items on (default,type) and
        // (b) records the surfaceKey in the device-local `hiddenBuiltins` so the
        // surface drops off this rail.
        deleteBuiltin(listId, type) {
            const pred = typePredicate(type)
            for (const item of store.getState().items.filter((i) => i.listId === listId && pred(i))) {
                send(RPC_DELETE, { item })
            }
            const key = surfaceLabelKey(listId, type)
            const hidden = Array.isArray(store.getState().preferences.hiddenBuiltins) ? store.getState().preferences.hiddenBuiltins : []
            if (!hidden.includes(key)) store.setPreferences({ hiddenBuiltins: [...hidden, key] })
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
        // Remove a plan entry (unflag an item / clear a list-card). An empty
        // plannedFor is the conflict-free clear (reducePlan drops it).
        clearFromPlan(ref) {
            const rec = reducePlan(store.getState().items).get(ref)
            if (!rec) return
            const entry = buildPlanItem({ id: ref, kind: rec.kind, refListId: rec.refListId, refItemId: rec.refItemId, refType: rec.refType, plannedFor: '', planOrder: rec.planOrder, updatedAt: now() })
            markLocalId(ref)
            send(RPC_UPDATE, { item: entry })
        },
        reorderPlanDay(dayRecords, fromIndex, toIndex) {
            const { updates } = computePlanReorder(dayRecords, fromIndex, toIndex)
            if (!updates.length) return
            const ts = now()
            for (const u of updates) {
                const rec = dayRecords.find((r) => r.ref === u.ref)
                if (!rec) continue
                const entry = buildPlanItem({ id: rec.ref, kind: rec.kind, refListId: rec.refListId, refItemId: rec.refItemId, refType: rec.refType, plannedFor: rec.plannedFor, planOrder: u.planOrder, updatedAt: ts })
                markLocalId(rec.ref)
                send(RPC_UPDATE, { item: entry })
            }
        },
        setOverviewView(view) {
            store.setPreferences({ overviewView: view === 'planner' ? 'planner' : 'focus' })
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
        // Move an item to a different list and/or type, WITHIN this project. The
        // backend decomposes it into add+delete (different listId) or a single
        // in-place type flip (same listId). Promoting an item into a rigor board
        // first collects the required ticket fields via the create form, so the
        // backend's rigor gate never silently drops it.
        moveItem(item, targetListId, targetType) {
            if (!item) return
            if (item.listId === targetListId && surfaceForType(item.listType) === surfaceForType(targetType)) return
            if (isBoardType(targetType)) {
                const config = selectBoardConfig(store.getState())
                const candidate = { text: item.text, description: item.description, checklist: item.checklist, estimatedHours: item.estimatedHours, estimatedComplexity: item.estimatedComplexity }
                if (config.rigorOn && validateRigorDraft(candidate, config).missing.length > 0) {
                    const tasks = (Array.isArray(item.checklist) && item.checklist.length) ? item.checklist.map((task) => task.text) : ['']
                    openDialog({
                        kind: 'add-ticket',
                        moveFrom: item,
                        targetListId,
                        draft: {
                            description: item.description || item.text || '',
                            tasks,
                            hours: item.estimatedHours ? String(item.estimatedHours) : '',
                            complexity: Number.isFinite(item.estimatedComplexity) ? item.estimatedComplexity : 50,
                        },
                    })
                    return
                }
            }
            markLocalId(item.id)
            send(RPC_MOVE, { item, targetListId, targetListType: isBoardType(targetType) ? BOARD_WRITE_TYPE : targetType })
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
            ui.blockCaret = null
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
            ui.blockCaret = null
            actions.commitBlocks(item, next)
            renderAll()
        },
        replaceBlock(item, blockId, type) {
            const block = createBlock(type, blockId)
            const blocks = normalizeBlocks(item.blocks).map((b) => (b.id === blockId ? block : b))
            ui.blockMenu = null
            ui.blockEditingId = blockId
            ui.blockDraft = blockToText(block)
            ui.blockCaret = null
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
        share() {
            send(RPC_CREATE_INVITE)
            openDialog({ kind: 'share' })
        },
        // Promote ONE list to its own shared base and show its co-edit invite.
        // Distinct from share() (the whole-project invite): others who join this
        // invite get only this list, not the rest.
        async shareList(listId) {
            if (!listId) return
            let result = null
            try {
                const reply = await send(RPC_SHARE_LIST, { listId })
                result = reply ? JSON.parse(reply) : null
            } catch { result = null }
            if (result && result.ok && result.invite) {
                openDialog({ kind: 'share-list', invite: result.invite })
            } else if (result && result.reason === 'cannot-share-builtin') {
                // The built-in Groceries/Board/Todo surfaces multiplex listId
                // 'default'; sharing it would strand all three. Explain why.
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
            closeDialog()
            let result = null
            try {
                const reply = await send(RPC_JOIN_LIST, { invite: value })
                result = reply ? JSON.parse(reply) : null
            } catch { result = null }
            store.pushNotice(
                result && result.ok ? locale.i18n.t('joinList.joined') : locale.i18n.t('joinList.failed'),
                result && result.ok ? 'success' : 'error',
            )
        },
        async requestJoin(input) {
            const value = input.trim().replace(/\s+/g, '')
            if (!value) {
                store.pushNotice(locale.i18n.t('invite.notification.emptyManual'), 'error')
                return
            }
            // Require a backup password so the current lists are backed up before
            // joining replaces the local base. (A backend hiccup → don't block.)
            const info = await backupRequest(RPC_LIST_BACKUPS)
            ui.backupPasswordSet = !!(info && info.passwordSet)
            if (info && info.passwordSet === false) {
                store.pushNotice(locale.i18n.t('backup.auto.joinNeedsPassword'), 'error')
                openDialog({ kind: 'settings' })
                loadAutoBackups()
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
    // Servers, Congruency and Activity no longer have their own nav entries:
    // Servers is now a section inside the Peers & Devices pane, and Congruency
    // + Activity live in Settings → Analytics.
    const SYSTEM_DEFS = [
        { key: 'peers', icon: 'users', label: (t) => t('desktop.nav.peers') },
        { key: 'settings', icon: 'settings', label: (t) => t('desktop.nav.settings'), action: () => { openDialog({ kind: 'settings' }); loadAutoBackups() } },
    ]
    // Map a list type to its pane/view key. System views sit outside this.
    const surfaceForType = (type) => (isBoardType(type) ? 'board' : isTodoType(type) ? 'todo' : 'lists')
    const iconForType = (type) => (isBoardType(type) ? 'layout-grid' : isTodoType(type) ? 'checklist' : 'shopping-cart')

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
    root.append(titlebar, shell, hintsHost, noticesHost, dialogHost)

    function openDialog(dialog) {
        ui.dialog = dialog
        renderAll()
    }
    function closeDialog() {
        ui.dialog = null
        renderAll()
    }

    // --- list navigation ----------------------------------------------------
    // A rail *surface* is a (listId, type) pair. Desktop's legacy data lives on
    // a single list (listId 'default') differentiated only by listType, so that
    // list yields three "built-in" surfaces — Groceries / Board / Todo — sharing
    // listId 'default'. These are now presented as ordinary deletable lists
    // inside the "general" group. Each registry-declared list is one surface on
    // its own listId. The active surface is (ui.activeListId, ui.activeType), and
    // item filtering keys on BOTH so board/todo on the default list never bleed
    // into the grocery view (and vice-versa).
    const GROCERY_TYPE = 'shopping'
    // The localized default label key for a built-in surface type.
    function builtinFallbackKey(type) {
        if (isBoardType(type)) return 'desktop.rail.board'
        if (isTodoType(type)) return 'desktop.rail.todo'
        return 'desktop.rail.groceries'
    }
    // A built-in surface's display name: a synced rename override (surface label)
    // if present, else the localized default. `surfaceLabels` is the reduced
    // Map<surfaceKey,name>; pass it in so callers reduce state.items once.
    function builtinDisplayName(type, surfaceLabels) {
        const t = locale.i18n.t.bind(locale.i18n)
        return surfaceLabels.get(surfaceLabelKey(DEFAULT_LIST_ID, type)) || t(builtinFallbackKey(type))
    }
    function typePredicate(type) {
        if (isBoardType(type)) return (item) => isBoardType(item.listType)
        if (isTodoType(type)) return (item) => isTodoItem(item)
        return (item) => isGroceryItem(item)
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
        const hasOnDefault = (pred) => items.some((item) => item.listId === DEFAULT_LIST_ID && pred(item))
        // Synced rename overrides for the built-in surfaces (reduced once).
        const surfaceLabels = reduceSurfaceLabels(items)
        // Synced group placement for the built-in surfaces (surfaceKey -> groupId).
        const syncedBuiltinGroups = reduceBuiltinGroups(items)
        // Built-ins the user has deleted on THIS device are hidden (device-local).
        const hidden = new Set(Array.isArray(state.preferences.hiddenBuiltins) ? state.preferences.hiddenBuiltins : [])
        const builtinVisible = (type) => !hidden.has(surfaceLabelKey(DEFAULT_LIST_ID, type))

        // The former built-ins on the default list, now general-group lists.
        // Board follows the gate-creation-only rule: shown when boardEnabled OR a
        // board already has tickets, so synced/existing boards stay reachable.
        const builtins = []
        if (builtinVisible(GROCERY_TYPE)) builtins.push({ listId: DEFAULT_LIST_ID, type: GROCERY_TYPE, name: builtinDisplayName(GROCERY_TYPE, surfaceLabels), builtin: true })
        if (builtinVisible(BOARD_LIST_TYPE) && (state.preferences.boardEnabled || hasOnDefault((item) => isBoardType(item.listType)))) {
            builtins.push({ listId: DEFAULT_LIST_ID, type: BOARD_LIST_TYPE, name: builtinDisplayName(BOARD_LIST_TYPE, surfaceLabels), builtin: true })
        }
        if (builtinVisible(TODO_LIST_TYPE)) builtins.push({ listId: DEFAULT_LIST_ID, type: TODO_LIST_TYPE, name: builtinDisplayName(TODO_LIST_TYPE, surfaceLabels), builtin: true })

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
            if (ui.view === 'board' || ui.view === 'todo') ui.view = 'lists'
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
    function renderMain(state) {
        // Pane swaps (view change, list/grid flip, entering the full-screen
        // ticket doc) get an entrance; ordinary state updates re-render in place
        // without re-animating.
        const paneKey = `${ui.ticketDocId ? `doc:${ui.ticketDocId}` : `${ui.view}:${ui.activeListId}`}:${state.preferences.isGridView}`
        if (prevPane !== paneKey) {
            prevPane = paneKey
            main.classList.remove('pane-enter')
            void main.offsetWidth
            main.classList.add('pane-enter')
        }
        // Expose the active view so panes can scope layout rules without a
        // wrapper element (children render directly into `main`).
        main.dataset.view = ui.ticketDocId ? 'doc' : ui.view
        // Background scroll-lock for the board drawer: cleared on every render so
        // it can't linger when leaving the board view; renderBoardPane re-adds it
        // when a ticket drawer is open (see there).
        document.documentElement.classList.remove('board-drawer-open')
        if (ui.ticketDocId) return renderTicketFull(state)
        if (ui.view === 'overview') return renderOverviewPane(state)
        // A list surface ('lists' | 'board' | 'todo') needs an active list; with
        // none selected (launch, or the active list was just deleted) show the
        // "pick or create a list" placeholder instead.
        const isListSurface = ui.view === 'lists' || ui.view === 'board' || ui.view === 'todo'
        if (isListSurface && ui.activeListId == null) return renderNoListPane(state)
        if (ui.view === 'board') return renderBoardPane(state)
        if (ui.view === 'todo') return renderTodoPane(state)
        if (ui.view === 'peers') return renderPeersPane(state)
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
            ['[ ]', t('desktop.hints.list')],
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

    // --- Overview (the cross-list day plan) ---------------------------------
    // A read-only aggregation: items/lists flagged into a day (the synced plan
    // channel) joined back to their live source items. Marking done / editing a
    // row writes through to the SOURCE item; list-cards open their list and clear
    // from the plan when checked. Two layouts: Focus (spotlight + today) and
    // Planner (today agenda + a week rail). Calendar events are out of v1.
    function openSurfaceById(listId, type) {
        selectSurface(store.getState(), { listId, type })
    }
    function parsePlanKey(key) {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || '')
        return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(now())
    }
    function planSurfaceName(listId, type, registry, surfaceLabels) {
        if (listId === DEFAULT_LIST_ID) return builtinDisplayName(type, surfaceLabels)
        return registry.lists.find((l) => l.id === listId)?.name || listId
    }
    function renderOverviewPane(state) {
        const t = locale.i18n.t.bind(locale.i18n)
        const reduced = reducePlan(state.items)
        const byDate = groupPlanByDate(reduced)
        const registry = reduceRegistry(state.items)
        const surfaceLabels = reduceSurfaceLabels(state.items)
        const byKey = new Map()
        for (const it of state.items) byKey.set(`${it.listId}::${it.id}`, it)

        // Board tickets track "done" via status, not isDone — route their overview
        // checkbox through a board status change so the source column updates too.
        const boardConfig = selectBoardConfig(state)
        const boardDone = new Set(doneStatusesOf(boardConfig))
        const firstDoneStatus = doneStatusesOf(boardConfig)[0] || 'done'
        const firstOpenStatus = (boardConfig.states || []).map((s) => s.id).find((id) => !boardDone.has(id)) || 'todo'
        const isItemDone = (item) => (isBoardType(item.listType) ? (item.isDone || boardDone.has(item.status)) : !!item.isDone)
        const toggleItemDone = (item) => {
            if (isBoardType(item.listType)) actions.moveTicket(item, isItemDone(item) ? firstOpenStatus : firstDoneStatus)
            else actions.toggleItem(item)
        }

        const today = toDateKey(now())
        const week = Array.from({ length: 7 }, (_, i) => shiftDateKey(today, i))
        const selected = (ui.planDate && week.includes(ui.planDate)) ? ui.planDate : today
        const view = state.preferences.overviewView === 'planner' ? 'planner' : 'focus'

        // Resolve a plan record to a renderable row, dropping dangling item refs.
        const resolve = (rec) => {
            if (rec.kind === 'list') {
                const scoped = state.items.filter((it) => it.listId === rec.refListId && typePredicate(rec.refType)(it))
                return {
                    rec,
                    kind: 'list',
                    listId: rec.refListId,
                    listType: rec.refType,
                    label: planSurfaceName(rec.refListId, rec.refType, registry, surfaceLabels),
                    count: selectSummary(scoped).remaining,
                }
            }
            const src = byKey.get(`${rec.refListId}::${rec.refItemId}`)
            if (!src) return null
            return {
                rec,
                kind: 'item',
                item: src,
                done: isItemDone(src),
                label: src.text,
                chip: planSurfaceName(rec.refListId, src.listType, registry, surfaceLabels),
            }
        }
        const resolveDay = (dateKey) => (byDate.get(dateKey) || []).map(resolve).filter(Boolean)

        // Drag within a day reorders; drop onto a day pill re-plans to that day.
        const planDnd = (rec, dayRecords, index) => ({
            draggable: 'true',
            ondragstart: (event) => {
                ui.planDrag = { ref: rec.ref, fromDate: rec.plannedFor }
                event.dataTransfer.effectAllowed = 'move'
                try { event.dataTransfer.setData('text/plain', rec.ref) } catch { /* some platforms reject */ }
                event.currentTarget.classList.add('dragging')
                event.stopPropagation()
            },
            ondragend: (event) => { event.currentTarget.classList.remove('dragging', 'drop-before', 'drop-after'); ui.planDrag = null },
            ondragover: (event) => {
                const d = ui.planDrag
                if (!d || d.ref === rec.ref || d.fromDate !== rec.plannedFor) return
                event.preventDefault(); event.stopPropagation()
                const before = dropBefore(event, 'y')
                event.currentTarget.classList.toggle('drop-before', before)
                event.currentTarget.classList.toggle('drop-after', !before)
            },
            ondragleave: (event) => { event.currentTarget.classList.remove('drop-before', 'drop-after') },
            ondrop: (event) => {
                const d = ui.planDrag
                event.currentTarget.classList.remove('drop-before', 'drop-after')
                if (!d || d.fromDate !== rec.plannedFor) return
                event.preventDefault(); event.stopPropagation()
                ui.planDrag = null
                const before = dropBefore(event, 'y')
                const fromIndex = dayRecords.findIndex((r) => r.ref === d.ref)
                if (fromIndex < 0) return
                const insertAt = before ? index : index + 1
                actions.reorderPlanDay(dayRecords, fromIndex, insertAt > fromIndex ? insertAt - 1 : insertAt)
            },
        })

        const planRow = (resolved, dayRecords, index, opts = {}) => {
            const draggable = !!(dayRecords && dayRecords.length > 1)
            const dnd = draggable ? planDnd(resolved.rec, dayRecords, index) : {}
            // A visible grip on reorderable rows so drag-to-reorder (and drag onto
            // a day pill) is discoverable; the whole row is the drag source.
            const grip = draggable
                ? h('span', { class: 'plan-grip', 'aria-hidden': 'true' }, tablerIcon('grip-vertical', { size: 14 }))
                : null
            if (resolved.kind === 'list') {
                return h('div', { class: `plan-row plan-list-card${opts.spotlight ? ' spotlight' : ''}`, ...dnd },
                    grip,
                    h('button', {
                        class: 'plan-check',
                        'aria-label': t('plan.clearFromPlan'),
                        title: t('plan.clearFromPlan'),
                        onclick: () => actions.clearFromPlan(resolved.rec.ref),
                    }, tablerIcon('square', { size: opts.spotlight ? 22 : 18 })),
                    h('span', { class: 'glyph' }, tablerIcon(iconForType(resolved.listType), { size: 16 })),
                    h('span', { class: 'plan-text', onclick: () => openSurfaceById(resolved.listId, resolved.listType) }, resolved.label),
                    h('span', { class: 'plan-chip' }, t('plan.listItems', { count: resolved.count })),
                    h('button', {
                        class: 'plan-open',
                        'aria-label': t('plan.openList'),
                        onclick: () => openSurfaceById(resolved.listId, resolved.listType),
                    }, tablerIcon('chevron-right', { size: 16 })),
                )
            }
            const item = resolved.item
            if (ui.editingItemId === item.id) {
                const editInput = h('input', {
                    class: 'input',
                    value: item.text,
                    onkeydown: (event) => {
                        if (event.key === 'Enter') { actions.editItem(item, editInput.value); ui.editingItemId = null; renderAll() }
                        else if (event.key === 'Escape') { ui.editingItemId = null; renderAll() }
                    },
                    onblur: () => { ui.editingItemId = null; renderAll() },
                })
                queueMicrotask(() => editInput.focus())
                return h('div', { class: 'plan-row' }, editInput)
            }
            const done = isItemDone(item)
            return h('div', { class: `plan-row${done ? ' done' : ''}${opts.spotlight ? ' spotlight' : ''}`, ...dnd },
                grip,
                h('button', {
                    class: 'plan-check',
                    'aria-pressed': done ? 'true' : 'false',
                    'aria-label': t('main.item.toggle'),
                    onclick: () => toggleItemDone(item),
                }, tablerIcon(done ? 'square-check' : 'square', { size: opts.spotlight ? 22 : 18 })),
                h('span', { class: 'plan-text', ondblclick: () => { ui.editingItemId = item.id; renderAll() } }, item.text),
                h('span', { class: 'plan-chip' }, resolved.chip),
                h('button', {
                    class: 'plan-remove',
                    'aria-label': t('plan.remove'),
                    title: t('plan.remove'),
                    onclick: () => actions.clearFromPlan(resolved.rec.ref),
                }, tablerIcon('x', { size: 14 })),
            )
        }

        // One day's agenda: spotlight (first pending) + next-up + a done tray.
        const dayAgenda = (dateKey) => {
            const rows = resolveDay(dateKey)
            const pending = rows.filter((r) => !r.done)
            const done = rows.filter((r) => r.done)
            const pendingRecords = pending.map((r) => r.rec)
            if (rows.length === 0) {
                return h('div', { class: 'plan-empty' },
                    h('p', { class: 'plan-empty-title' }, t('plan.empty.title')),
                    h('p', { class: 'label-md' }, t('plan.empty.hint')),
                )
            }
            const parts = []
            if (pending.length > 0) {
                parts.push(h('div', { class: 'plan-section-label label-sm' }, t('plan.now')))
                parts.push(h('div', { class: 'plan-spotlight-wrap' }, planRow(pending[0], pendingRecords, 0, { spotlight: true })))
                if (pending.length > 1) {
                    parts.push(h('div', { class: 'plan-section-label label-sm' }, t('plan.nextUp')))
                    parts.push(h('div', { class: 'plan-rows' }, ...pending.slice(1).map((r, i) => planRow(r, pendingRecords, i + 1))))
                }
            }
            if (done.length > 0) {
                parts.push(h('div', { class: 'plan-done-tray' },
                    h('span', { class: 'glyph done' }, tablerIcon('square-check', { size: 14 })),
                    h('span', { class: 'label-sm' }, t('plan.doneToday', { count: done.length })),
                ))
                parts.push(h('div', { class: 'plan-rows plan-done-rows' }, ...done.map((r) => planRow(r, [], 0))))
            }
            return h('div', {}, ...parts)
        }

        // The clickable + droppable 7-day strip.
        const strip = h('div', { class: 'plan-strip' }, ...week.map((dk) => {
            const count = resolveDay(dk).length
            return h('button', {
                class: `plan-pill${dk === selected ? ' selected' : ''}${dk === today ? ' today' : ''}`,
                onclick: () => { ui.planDate = dk; renderAll() },
                ondragover: (event) => { if (ui.planDrag) { event.preventDefault(); event.currentTarget.classList.add('drop') } },
                ondragleave: (event) => { event.currentTarget.classList.remove('drop') },
                ondrop: (event) => {
                    event.preventDefault(); event.currentTarget.classList.remove('drop')
                    const d = ui.planDrag; ui.planDrag = null
                    if (d) actions.movePlanToDay(d.ref, dk)
                },
            },
                h('span', { class: 'pill-dow label-sm' }, dk === today ? t('plan.today') : dk === week[1] ? t('plan.tomorrow') : parsePlanKey(dk).toLocaleDateString(undefined, { weekday: 'short' })),
                h('span', { class: 'pill-day' }, String(parsePlanKey(dk).getDate())),
                h('span', { class: `pill-count label-sm${count === 0 ? ' zero' : ''}` }, count > 0 ? String(count) : '·'),
            )
        }))

        const header = h('header', { class: 'page-header' },
            h('div', {},
                h('h1', { class: 'page-title title-lg' }, t('desktop.nav.overview')),
                h('div', { class: 'summary-bar label-md plan-subhead' },
                    h('span', { class: `dot${state.peerCount > 0 ? ' live' : ''}` }),
                    h('span', {}, parsePlanKey(today).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })),
                ),
            ),
            h('div', { class: 'header-actions' },
                h('span', { class: 'plan-viewtoggle' },
                    h('button', { class: `seg${view === 'focus' ? ' active' : ''}`, onclick: () => actions.setOverviewView('focus') }, t('plan.focus')),
                    h('button', { class: `seg${view === 'planner' ? ' active' : ''}`, onclick: () => actions.setOverviewView('planner') }, t('plan.planner')),
                ),
            ),
        )

        if (view === 'planner') {
            const rail = h('div', { class: 'plan-week-rail' }, ...week.map((dk) => {
                const rows = resolveDay(dk)
                return h('section', {
                    class: `plan-week-day${dk === selected ? ' selected' : ''}${dk === today ? ' today' : ''}`,
                    onclick: () => { ui.planDate = dk; renderAll() },
                    ondragover: (event) => { if (ui.planDrag) { event.preventDefault(); event.currentTarget.classList.add('drop') } },
                    ondragleave: (event) => { event.currentTarget.classList.remove('drop') },
                    ondrop: (event) => { event.preventDefault(); event.currentTarget.classList.remove('drop'); const d = ui.planDrag; ui.planDrag = null; if (d) actions.movePlanToDay(d.ref, dk) },
                },
                    h('div', { class: 'plan-week-head' },
                        h('span', {}, dk === today ? t('plan.today') : dk === week[1] ? t('plan.tomorrow') : parsePlanKey(dk).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })),
                        h('span', { class: `pill-count label-sm${rows.length === 0 ? ' zero' : ''}` }, rows.length > 0 ? String(rows.length) : '·'),
                    ),
                    rows.length === 0
                        ? h('div', { class: 'plan-week-empty label-sm' }, t('plan.empty.none'))
                        : h('div', { class: 'plan-week-rows' }, ...rows.map((r) => h('div', { class: `plan-week-row${r.done ? ' done' : ''}` },
                            tablerIcon(r.kind === 'list' ? iconForType(r.listType) : (r.done ? 'square-check' : 'square'), { size: 13 }),
                            h('span', {}, r.label),
                        ))),
                )
            }))
            return replaceChildren(main, header, strip,
                h('div', { class: 'plan-planner' },
                    h('div', { class: 'plan-agenda' }, dayAgenda(selected)),
                    rail,
                ),
            )
        }

        // Focus layout: selected-day agenda, plus a receded Tomorrow when on today.
        const parts = [header, strip, h('div', { class: 'plan-focus' }, dayAgenda(selected))]
        if (selected === today) {
            const tomorrow = resolveDay(week[1]).filter((r) => !r.done)
            if (tomorrow.length > 0) {
                parts.push(h('div', { class: 'plan-tomorrow' },
                    h('div', { class: 'plan-section-label label-sm' }, t('plan.tomorrow')),
                    h('div', { class: 'plan-rows' }, ...tomorrow.map((r) => planRow(r, [], 0))),
                ))
            }
        }
        return replaceChildren(main, ...parts)
    }

    function renderListsPane(state) {
        const t = locale.i18n.t.bind(locale.i18n)
        const { preferences } = state
        const items = itemsForActiveList(state)
        const summary = selectSummary(items)
        const title = activeSurface(state)?.name || t('desktop.rail.groceries')

        const statusKey = !state.backendReady
            ? 'header.status.starting'
            : state.peerCount > 0 ? 'header.status.synced' : 'header.status.ready'

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
        const items = sortByOrder(itemsForActiveList(state))
        const summary = selectSummary(items)
        const title = activeSurface(state)?.name || t('desktop.rail.todo')
        const statusKey = !state.backendReady
            ? 'header.status.starting'
            : state.peerCount > 0 ? 'header.status.synced' : 'header.status.ready'

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
                    ...items.map((item, i) => renderItemRow(item, tablerIcon(item.isDone ? 'square-check' : 'square', { size: 18 }), items, i)),
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
            onkeydown: (event) => handleItemKeys(event, item, group, index),
            onfocus: () => { ui.focusedItemId = item.id },
        }
        if (group.length > 1) Object.assign(props, reorderDnd(item, group, index, 'y'))
        const planned = plannedRefs.has(planItemKey(item.listId, item.id))
        return h('div', props,
            h('span', { class: 'glyph' }, glyph),
            h('span', { class: 'item-text' }, item.text),
            h('div', { class: 'row-actions' },
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
        const columns = groupByStatus(itemsForActiveList(state), config)
        const nowMs = now()
        const board = h('div', { class: 'board-grid' }, ...columns.map((col) => renderBoardColumn(col, nowMs, config.rigorOn)))
        const selected = selectedTicket(state)
        // Lock the page (html) scroll while the drawer is open so wheel/trackpad
        // input over the drawer never chains through to the board behind it.
        document.documentElement.classList.toggle('board-drawer-open', !!selected)
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
                    h('button', { class: 'btn btn-critical', onclick: actions.share }, t('desktop.header.share')),
                ),
            ),
            board,
            selected ? renderTicketDrawer(selected, state) : null,
        )
    }

    function renderBoardColumn(col, nowMs, rigorOn = false) {
        const t = locale.i18n.t.bind(locale.i18n)
        const s = col.state
        // groupByStatus keeps arrival order within a column; layer the user's
        // manual `order` on top so within-column drag/keyboard reordering sticks.
        const tickets = sortByOrder(col.tickets)
        const count = s.wipLimit > 0 ? `${tickets.length}/${s.wipLimit}` : String(tickets.length)
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
                ...tickets.map((ticket, i) => renderTicketCard(ticket, nowMs, tickets, i, rigorOn)),
                h('button', { class: 'board-add', onclick: () => actions.newTicket() },
                    tablerIcon('plus', { size: 14 }), t('board.add')),
            ),
        )
    }

    function renderTicketCard(item, nowMs, group = [], index = 0, rigorOn = false) {
        const t = locale.i18n.t.bind(locale.i18n)
        const b = ticketBadges(item, nowMs)
        const chips = []
        if (b.priority) chips.push(h('span', { class: `priority-pill ${b.priority}` }, t(`ticket.priority.${b.priority}`)))
        const meta = []
        if (b.assignee) meta.push(h('span', { class: 'ticket-avatar' }, ticketInitials(b.assignee)))
        if (b.checklistTotal > 0) {
            meta.push(h('span', { class: 'ticket-meta' }, tablerIcon('checklist', { size: 13 }), `${b.checklistDone}/${b.checklistTotal}`))
        }
        // Rigor mode surfaces the two planning estimates (time + complexity) on
        // every card so the board is scannable without opening each ticket.
        if (rigorOn) {
            if (b.estimatedHours) {
                meta.push(h('span', { class: 'ticket-meta', title: t('ticket.detail.estimate') },
                    tablerIcon('clock', { size: 13 }), `${b.estimatedHours}h`))
            }
            if (b.estimatedComplexity) {
                meta.push(h('span', { class: 'ticket-meta', title: t('ticket.detail.complexity') },
                    tablerIcon('activity', { size: 13 }), `${b.estimatedComplexity}`))
            }
        }
        if (b.isDone && b.timeliness) {
            const delta = deltaPercent(b.inProgressHours, b.estimatedHours)
            const suffix = delta != null ? ` ${delta > 0 ? '+' : ''}${delta}%` : ''
            meta.push(h('span', { class: `timeliness-badge ${b.timeliness}` }, t(`ticket.timeliness.${b.timeliness}`) + suffix))
        } else if (b.running) {
            // The estimate is already shown by the clock chip in rigor mode, so
            // only the non-rigor timer appends the "/ Xh" pace suffix.
            const pace = !rigorOn && b.estimatedHours ? ` / ${b.estimatedHours}h` : ''
            meta.push(h('span', { class: 'ticket-timer' },
                h('span', { class: 'timer-dot' }),
                `${formatDuration(b.inProgressMs)}${pace}`))
        }
        // Cards carry the cross-column drag (ui.boardDrag → column drop changes
        // status) AND within-column reorder: when the dragged card belongs to
        // this column, the card itself becomes the drop target (midpoint =
        // before/after); otherwise it stays inert so the event bubbles to the
        // column's status-change drop.
        const inColumn = (drag) => drag && group.some((ticket) => ticket && ticket.id === drag.id)
        return h('article', {
            class: `ticket-card${ui.selectedTicketId === item.id ? ' selected' : ''}`,
            tabindex: '0',
            draggable: 'true',
            dataset: { itemId: item.id, status: item.status || 'todo' },
            onclick: () => actions.openTicket(item.id),
            onkeydown: (event) => {
                if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown') && group.length > 1) {
                    event.preventDefault()
                    event.stopPropagation()
                    reorderItemByStep(group, item, event.key === 'ArrowDown' ? 1 : -1)
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
        // Only carry the previous element's text across a re-render when it was
        // focused — that's the half-typed draft we must not eat. An unfocused
        // field has no uncommitted draft (blur commits), so it shows the canonical
        // value; otherwise switching tickets would inherit the prior ticket's title.
        if (prev && main.ownerDocument.activeElement === prev) {
            el.value = prev.value
            queueMicrotask(() => { el.focus(); const p = el.value.length; try { el.setSelectionRange(p, p) } catch { /* number/date inputs reject */ } })
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
            h('div', { class: 'ticket-summary-tasks' },
                h('h3', { class: 'category-heading label-sm' }, t('ticket.detail.tasks')),
                checklist.length
                    ? h('div', { class: 'detail-checklist' }, ...checklist.map((task) => h('div', { class: `detail-task${task.done ? ' done' : ''}` },
                        h('label', { class: 'detail-task-main' },
                            h('input', { type: 'checkbox', checked: task.done ? '' : null, onchange: () => actions.toggleTicketTask(item, task.id) }),
                            h('span', {}, task.text),
                        ),
                        h('button', { class: 'detail-task-remove', type: 'button', 'aria-label': t('common.remove'), title: t('common.remove'), onclick: () => actions.removeTicketTask(item, task.id) }, tablerIcon('x', { size: 13 })),
                    )))
                    : null,
                renderTaskAddBar(item, t),
            ),
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
                // Same block model (markdownToHtml) the editor seeds with, so
                // clicking into the block is visually seamless.
                const div = h('div', { class: 'block-md block-rich', onclick: edit })
                div.innerHTML = markdownToHtml(text)
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
        const menu = isMarkdown ? renderSlashMenu(item, { mode: 'replace', blockId: block.id }) : null
        if (menu) menu.classList.add('block-slash-inline', ui.blockDraft === '/' ? 'open' : 'hidden')

        const ed = h('div', {
            class: `block-md block-rich block-editor block-rich-${block.type}`,
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

        // Remember the caret across re-renders (the app rebuilds this editor on
        // every P2P/local store update); null means "place at end" on next build.
        const remember = () => { ui.blockCaret = richCaretOffset(ed) }
        const sync = () => {
            ui.blockDraft = htmlToMarkdown(ed.innerHTML)
            ed.classList.toggle('is-empty', ui.blockDraft === '')
            remember()
            if (menu) {
                menu.classList.toggle('hidden', ui.blockDraft !== '/')
                menu.classList.toggle('open', ui.blockDraft === '/')
            }
        }
        ed.addEventListener('input', () => {
            // Live-interpret recognized markdown so the raw syntax never lingers.
            if (isMarkdown && applyHeadingInputRule(ed)) { sync(); return }
            applyInlineInputRules()
            sync()
        })
        ed.addEventListener('keyup', remember)
        ed.addEventListener('mouseup', remember)
        ed.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') { event.stopPropagation(); actions.cancelBlockEdit(); return }
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
            const live = root.querySelector('.block-editor')
            if (live && live !== ed && main.ownerDocument.activeElement === live) return
            if (ui.blockEditingId === block.id) actions.commitBlockEdit(item)
        }))

        queueMicrotask(() => {
            if (main.ownerDocument.activeElement === ed) return
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
            } catch { /* ignore */ }
        })
        return h('div', { class: 'block-editor-wrap' }, ed, menu)
    }

    function renderBlockEditor(item, block) {
        if (block.type === 'markdown' || block.type === 'callout') return renderRichBlockEditor(item, block)
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

    function renderTicketDrawer(item, state) {
        const t = locale.i18n.t.bind(locale.i18n)
        return h('aside', { class: 'detail-drawer' },
            h('div', { class: 'detail-toolbar' },
                h('button', { class: 'btn btn-secondary btn-icon', type: 'button', 'aria-label': t('ticket.detail.openFull'), title: t('ticket.detail.openFull'), onclick: () => actions.promoteTicket(item.id) }, tablerIcon('arrows-maximize', { size: 15 })),
                h('button', { class: 'btn btn-secondary btn-icon', type: 'button', 'aria-label': t('main.item.move'), title: t('main.item.move'), onclick: () => openDialog({ kind: 'item-move', item }) }, tablerIcon('switch-horizontal', { size: 15 })),
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

    // Congruency analytics body (used inside Settings → Analytics). Returns the
    // nodes; the caller supplies the surrounding heading and container.
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
                    h('button', { class: 'btn btn-secondary', onclick: () => openDialog({ kind: 'join-list' }) }, t('joinList.button')),
                    h('button', { class: 'btn btn-secondary', onclick: () => openDialog({ kind: 'join' }) }, t('desktop.header.join')),
                    h('button', { class: 'btn btn-critical', onclick: actions.share }, t('desktop.header.share')),
                ),
            ),
            h('div', { class: 'summary-bar label-md' },
                h('span', { class: `dot${state.peerCount > 0 ? ' live' : ''}` }),
                h('span', {}, state.peerCount === 0
                    ? t('desktop.peers.none')
                    : t('desktop.peers.connected', { count: state.peerCount })),
            ),
            h('section', { class: 'pane-section' },
                h('h3', { class: 'category-heading label-sm' }, t('members.title')),
                h('div', { class: 'kv-rows' }, ...renderMemberRows(members)),
            ),
            buildServersSection(t),
            h('section', { class: 'pane-section' },
                h('h3', { class: 'category-heading label-sm' }, t('desktop.peers.invite.title')),
                state.inviteKey
                    ? h('div', {},
                        h('div', { class: 'invite-code' }, state.inviteKey),
                        h('div', { style: 'margin-top: 1rem;' },
                            h('button', { class: 'btn btn-primary', onclick: copyInvite }, t('desktop.peers.copy'))),
                    )
                    : h('p', { class: 'body-md pane-note' }, t('desktop.peers.invite.none')),
            ),
            renderLeafBridge(state),
            renderVoice(state),
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

    // --- Servers pane (H1 owner-control) -----------------------------------
    // Monitor and reach the user's always-on headless peers (e.g. the Geekom):
    // pair via an operator-minted code, poll a signed, capability-scoped status
    // command over hyperdht, and issue safe controls (mint invite, export,
    // shutdown). Requires the Pear runtime; the browser preview shows the
    // unavailable state. Status is cached in ui.servers keyed by server key.
    function copyText(text, successKey) {
        return navigator.clipboard.writeText(text).then(
            () => store.pushNotice(locale.i18n.t(successKey), 'success'),
            () => store.pushNotice(locale.i18n.t('invite.share.failed'), 'error'),
        )
    }

    // Query one server's status; updates ui.servers[key] then re-renders. The
    // busy flag both shows a spinner-ish state and guards against overlapping
    // polls (the auto-poll and a manual click can race).
    function serverCan(key, capability) {
        const server = ownerControl?.listServers().find((entry) => entry.serverPublicKeyHex === key)
        return (server?.capabilities ?? []).includes(capability)
    }

    async function refreshServer(key, { silent = false } = {}) {
        if (!ownerControl) return
        const prev = ui.servers[key] ?? {}
        if (prev.busy) return
        // A server that never granted status:read would reject every status
        // request, so skip it (the card shows a no-access state instead).
        if (!serverCan(key, 'status:read')) return
        ui.servers[key] = { ...prev, busy: true }
        if (!silent) renderAll()
        // Re-read the live entry at write time rather than reusing the pre-await
        // `prev`: a poll resolving must not clobber an invite (or any field) set
        // by mintServerInvite/etc. while the status round-trip was in flight.
        // This handler owns only busy/status/error/fetchedAt. On failure we drop
        // `status` so the card shows a clean offline state, not stale stats.
        try {
            const reply = await ownerControl.request(key, 'status')
            const cur = ui.servers[key] ?? {}
            ui.servers[key] = reply?.ok
                ? { ...cur, status: reply.status, error: null, busy: false, fetchedAt: now() }
                : { ...cur, status: undefined, busy: false, error: reply?.reason ?? 'error', fetchedAt: now() }
        } catch (error) {
            const cur = ui.servers[key] ?? {}
            ui.servers[key] = { ...cur, status: undefined, busy: false, error: error?.message ?? 'error', fetchedAt: now() }
        }
        renderAll()
    }

    function refreshAllServers(opts) {
        if (!ownerControl) return
        // refreshServer self-skips servers without status:read.
        for (const server of ownerControl.listServers()) refreshServer(server.serverPublicKeyHex, opts)
    }

    async function mintServerInvite(key) {
        const t = locale.i18n.t.bind(locale.i18n)
        try {
            const reply = await ownerControl.request(key, 'invite')
            if (reply?.ok && reply.inviteKey) {
                ui.servers[key] = { ...(ui.servers[key] ?? {}), invite: reply.inviteKey }
                store.pushNotice(t('desktop.servers.inviteMinted'), 'success')
            } else {
                store.pushNotice(`${t('desktop.servers.inviteFailed')} (${reply?.reason ?? 'error'})`, 'error')
            }
        } catch (error) {
            store.pushNotice(`${t('desktop.servers.inviteFailed')} (${error?.message ?? 'error'})`, 'error')
        }
        renderAll()
    }

    async function exportServer(key) {
        const t = locale.i18n.t.bind(locale.i18n)
        try {
            const reply = await ownerControl.request(key, 'export')
            if (reply?.ok && reply.export) {
                await navigator.clipboard.writeText(JSON.stringify(reply.export, null, 2))
                const count = Array.isArray(reply.export.items) ? reply.export.items.length : 0
                store.pushNotice(t('desktop.servers.exported', { count }), 'success')
            } else {
                store.pushNotice(`${t('desktop.servers.exportFailed')} (${reply?.reason ?? 'error'})`, 'error')
            }
        } catch (error) {
            store.pushNotice(`${t('desktop.servers.exportFailed')} (${error?.message ?? 'error'})`, 'error')
        }
    }

    async function shutdownServer(key) {
        const t = locale.i18n.t.bind(locale.i18n)
        closeDialog()
        try {
            const reply = await ownerControl.request(key, 'shutdown')
            if (reply?.ok) store.pushNotice(t('desktop.servers.shutdownOk'), 'success')
            else store.pushNotice(`${t('desktop.servers.shutdownFailed')} (${reply?.reason ?? 'error'})`, 'error')
        } catch (error) {
            store.pushNotice(`${t('desktop.servers.shutdownFailed')} (${error?.message ?? 'error'})`, 'error')
        }
        // The peer is going away; drop its cached status (so it reads offline)
        // and any minted invite (a single-use code is useless once it shuts down).
        ui.servers[key] = { ...(ui.servers[key] ?? {}), status: undefined, error: null, invite: undefined }
        renderAll()
    }

    function renderServerStats(status, t) {
        const rows = []
        const add = (label, value) => rows.push(h('div', { class: 'kv-row' },
            h('span', { class: 'label-sm', style: 'color: var(--secondary);' }, label),
            h('span', { class: 'body-md' }, value),
        ))
        add(t('desktop.servers.field.role'), String(status.role ?? '—'))
        add(t('desktop.servers.field.joined'), status.joined ? t('desktop.servers.yes') : t('desktop.servers.no'))
        add(t('desktop.servers.field.peers'), String(status.peerCount ?? 0))
        add(t('desktop.servers.field.items'), String(status.itemCount ?? 0))
        if (status.quota) {
            add(t('desktop.servers.field.storage'),
                `${formatBytes(status.quota.usedBytes)} / ${formatBytes(status.quota.maxBytes)}${status.quota.exceeded ? ' ⚠' : ''}`)
        }
        add(t('desktop.servers.field.invite'), status.inviteActive ? t('desktop.servers.yes') : t('desktop.servers.no'))
        const leaf = status.leafBridge
        add(t('desktop.servers.field.leaf'), leaf ? (leaf.hubAddr || `:${leaf.port}`) : t('desktop.servers.leafOff'))
        if (leaf?.audioAddr) add(t('desktop.servers.field.voice'), leaf.audioAddr)
        if (status.startedAt) add(t('desktop.servers.field.uptime'), formatUptime(now() - status.startedAt))
        if (status.updatedAt) add(t('desktop.servers.field.updated'), t('desktop.servers.updatedAgo', { ago: formatAgo(now() - status.updatedAt) }))
        return h('div', { class: 'kv-rows' }, ...rows)
    }

    function renderServerCard(server, t) {
        const key = server.serverPublicKeyHex
        const entry = ui.servers[key] ?? {}
        const status = entry.status
        const online = !!status && !entry.error
        const caps = server.capabilities ?? []
        const can = (cap) => caps.includes(cap)
        const canRead = can('status:read')
        const stateLabel = !canRead
            ? t('desktop.servers.noStatusAccess')
            : entry.busy
                ? t('desktop.servers.checking')
                : (online ? t('desktop.servers.online') : t('desktop.servers.offline'))
        return h('div', { class: 'server-card' },
            h('div', { class: 'server-card-head' },
                h('span', { class: `dot${!entry.busy && online ? ' live' : ''}` }),
                h('span', { class: 'body-md server-name' }, server.name),
                h('span', { class: 'role-chip' }, key.slice(0, 8)),
                h('span', { class: 'label-sm server-state' }, stateLabel),
            ),
            status ? renderServerStats(status, t) : null,
            entry.error
                ? h('p', { class: 'body-md warning' }, t('desktop.servers.error', { message: entry.error }))
                : null,
            entry.invite
                ? h('div', {},
                    h('div', { class: 'invite-code' }, entry.invite),
                    h('div', { style: 'margin-top: 0.75rem;' },
                        h('button', { class: 'btn btn-secondary', onclick: () => copyText(entry.invite, 'desktop.peers.copied') }, t('desktop.peers.copy'))),
                )
                : null,
            h('p', { class: 'label-sm server-caps' },
                `${t('desktop.control.capabilities')}: ${caps.join(', ') || '—'}`),
            h('div', { class: 'choice-row server-actions' },
                canRead ? h('button', { class: 'btn btn-secondary', disabled: entry.busy ? '' : null, onclick: () => refreshServer(key) }, t('desktop.servers.refresh')) : null,
                can('invite:create') ? h('button', { class: 'btn btn-secondary', onclick: () => mintServerInvite(key) }, t('desktop.servers.mintInvite')) : null,
                can('export:create') ? h('button', { class: 'btn btn-secondary', onclick: () => exportServer(key) }, t('desktop.servers.export')) : null,
                can('service:shutdown')
                    ? h('button', { class: 'btn btn-danger', onclick: () => openDialog({ kind: 'server-shutdown', serverKey: key, serverName: server.name }) }, t('desktop.servers.shutdown'))
                    : null,
            ),
        )
    }

    function renderServerPairForm(t) {
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
        return h('div', { class: 'server-pair' },
            h('h3', { class: 'category-heading label-sm' }, t('desktop.servers.pairTitle')),
            h('p', { class: 'body-md pane-note' }, t('desktop.servers.pairHint')),
            h('div', { class: 'add-bar', style: 'margin-top: 1rem; margin-bottom: 0;' },
                codeInput,
                nameInput,
                h('button', { class: 'btn btn-primary', onclick: pairAction }, t('desktop.control.pair')),
            ),
        )
    }

    // Servers are remote headless peers operated over owner-control. They render
    // as a section *inside* the Peers & Devices pane (no longer a top-level nav
    // view). Returns the section nodes; the pane supplies the surrounding layout.
    function buildServersSection(t) {
        const heading = h('div', { class: 'pane-section-head' },
            h('h3', { class: 'category-heading label-sm' }, t('desktop.servers.title')),
            ownerControl ? h('button', { class: 'btn btn-secondary', onclick: () => refreshAllServers() }, t('desktop.servers.refreshAll')) : null,
        )
        if (!ownerControl) {
            return h('section', { class: 'pane-section' }, heading,
                h('p', { class: 'body-md pane-note' }, t('desktop.control.unavailable')),
            )
        }
        const servers = ownerControl.listServers()
        // Auto-query any status:read server we've never reached, so opening the
        // pane shows live status without a manual click. The busy guard in
        // refreshServer keeps re-renders from re-firing the in-flight request;
        // gating on the capability here avoids re-calling a no-op every render.
        for (const server of servers) {
            if (ui.servers[server.serverPublicKeyHex] === undefined && (server.capabilities ?? []).includes('status:read')) {
                refreshServer(server.serverPublicKeyHex, { silent: true })
            }
        }
        return h('section', { class: 'pane-section' }, heading,
            servers.length === 0
                ? h('p', { class: 'body-md pane-note' }, t('desktop.servers.empty'))
                : h('div', { class: 'server-cards' }, ...servers.map((server) => renderServerCard(server, t))),
            renderServerPairForm(t),
        )
    }

    function renderMemberRows(members) {
        const t = locale.i18n.t.bind(locale.i18n)
        if (members.length === 0) {
            return [h('p', { class: 'body-md', style: 'color: var(--secondary); padding: 0 1rem;' }, t('members.subtitle.none'))]
        }
        const canAdminister = store.getState().roster?.canAdminister
        // Synced device names; fall back to the raw writer key when unnamed.
        const peerNames = reducePeerLabels(store.getState().items)
        return members.map((member) => h('div', { class: 'member-row' },
            h('span', { class: 'who', title: member.writerKey }, peerNames.get(member.writerKey) || member.writerKey),
            h('span', { class: `role-chip${member.isOwner ? ' owner' : ''}` },
                member.isOwner ? t('members.role.owner') : member.isSelf ? t('members.role.self') : t('members.role.member')),
            canAdminister && !member.isSelf && !member.isOwner
                ? h('button', { class: 'btn btn-danger', onclick: () => actions.removeMember(member) }, t('common.remove'))
                : h('span', {}),
        ))
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

        if (kind === 'plan-day') {
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
        } else if (kind === 'share') {
            content = dialogFrame(t('invite.share.title'), [
                h('p', { class: 'dialog-body' }, t('invite.share.message')),
                state.inviteKey
                    ? h('div', { class: 'invite-code' }, state.inviteKey)
                    : h('p', { class: 'dialog-body' }, t('invite.share.notReady')),
            ], [
                state.inviteKey ? h('button', { class: 'btn btn-secondary', onclick: copyInvite }, t('desktop.peers.copy')) : null,
                h('button', { class: 'btn btn-primary', onclick: closeDialog }, t('common.close')),
            ])
        } else if (kind === 'share-list') {
            const invite = ui.dialog.invite || ''
            const copyShareInvite = async () => {
                if (!invite) return
                try { await navigator.clipboard.writeText(invite); store.pushNotice(t('desktop.peers.copied'), 'success') }
                catch { store.pushNotice(t('invite.share.failed'), 'error') }
            }
            content = dialogFrame(t('shareList.title'), [
                h('p', { class: 'dialog-body' }, t('shareList.message')),
                h('div', { class: 'invite-code' }, invite),
            ], [
                h('button', { class: 'btn btn-secondary', onclick: copyShareInvite }, t('desktop.peers.copy')),
                h('button', { class: 'btn btn-primary', onclick: closeDialog }, t('common.close')),
            ])
        } else if (kind === 'join-list') {
            const joinListInput = h('input', {
                class: 'input',
                placeholder: t('invite.dialog.placeholder'),
                onkeydown: (event) => { if (event.key === 'Enter') actions.joinList(joinListInput.value) },
            })
            content = dialogFrame(t('joinList.title'), [
                h('p', { class: 'dialog-body' }, t('joinList.subtitle')),
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
            ], [
                h('button', { class: 'btn btn-secondary', onclick: closeDialog }, t('common.cancel')),
                h('button', { class: 'btn btn-primary', onclick: () => actions.confirmJoin(ui.dialog.invite) }, t('common.join')),
            ])
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
            // Per-device gate for offering board creation. Always lets existing
            // boards stay visible; only the "New board" option is hidden when off.
            const boardRow = h('div', { class: 'choice-row' },
                h('button', {
                    class: `btn ${state.preferences.boardEnabled ? 'btn-primary' : 'btn-secondary'}`,
                    'aria-pressed': state.preferences.boardEnabled ? 'true' : 'false',
                    onclick: () => store.setPreferences({ boardEnabled: true }),
                }, t('settings.board.on')),
                h('button', {
                    class: `btn ${!state.preferences.boardEnabled ? 'btn-primary' : 'btn-secondary'}`,
                    'aria-pressed': !state.preferences.boardEnabled ? 'true' : 'false',
                    onclick: () => store.setPreferences({ boardEnabled: false }),
                }, t('settings.board.off')),
            )
            content = dialogFrame(t('desktop.settings.title'), [
                h('h3', { class: 'category-heading label-sm' }, t('desktop.settings.deviceName.label')),
                deviceNameInput,
                h('p', { class: 'label-md', style: 'color: var(--secondary);' }, t('desktop.settings.deviceName.help')),
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
                // Analytics: congruency calibration + recent backend activity,
                // relocated here from their former top-level nav views.
                h('h3', { class: 'category-heading label-sm' }, t('desktop.analytics.title')),
                h('div', { class: 'analytics-section' },
                    h('h4', { class: 'analytics-subhead label-sm' }, t('congruency.title')),
                    ...congruencyContent(state),
                    ...activityContent(state),
                ),
            ], [
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
            // surface label. It lives in "general"; delete clears its items and
            // hides it from this device (no registry meta-item to tombstone).
            const type = ui.dialog.builtinType
            const listId = ui.dialog.listId
            const resolvedName = builtinDisplayName(type, reduceSurfaceLabels(state.items))
            const nameInput = h('input', { class: 'input', value: resolvedName })
            // Empty clears the override (reverts to the localized default).
            const commitName = () => { const nv = nameInput.value.trim(); if (nv !== resolvedName) actions.renameBuiltin(listId, type, nv) }
            nameInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') { commitName(); closeDialog() } })
            nameInput.addEventListener('blur', commitName)
            content = dialogFrame(resolvedName || t('desktop.list.settings'), [
                h('h3', { class: 'category-heading label-sm' }, t('desktop.list.rename')),
                nameInput,
                h('p', { class: 'label-md', style: 'color: var(--secondary);' }, t('desktop.list.renameBuiltinHelp')),
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
            ])
            queueMicrotask(() => nameInput.focus())
        } else if (kind === 'list-settings') {
            const registry = reduceRegistry(state.items)
            const entry = registry.lists.find((l) => l.id === ui.dialog.listId)
            if (!entry) { closeDialog(); return }
            const listId = ui.dialog.listId
            const nameInput = h('input', { class: 'input', value: entry.name })
            const commitName = () => { const nv = nameInput.value.trim(); if (nv && nv !== entry.name) actions.renameList(listId, nv) }
            nameInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') { commitName(); closeDialog() } })
            nameInput.addEventListener('blur', commitName)
            // Every list belongs to a group; offer existing groups (always with
            // "general") and preselect the current one, defaulting to general.
            const groupChoices = [...registry.groups]
            if (!groupChoices.some((g) => g.id === GENERAL_GROUP_ID)) groupChoices.unshift({ id: GENERAL_GROUP_ID, name: t('desktop.group.general') })
            const currentGroupId = groupChoices.some((g) => g.id === entry.groupId) ? entry.groupId : GENERAL_GROUP_ID
            const groupSelect = h('select', {
                class: 'prop-select',
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
                h('h3', { class: 'category-heading label-sm' }, t('shareList.title')),
                // The built-in surfaces multiplex listId 'default' and cannot be
                // shared on their own (the backend refuses it) — show why instead
                // of a share button that would only error.
                listId === DEFAULT_LIST_ID
                    ? h('p', { class: 'label-md', style: 'color: var(--secondary);' }, t('shareList.builtinBlocked'))
                    : entry.baseKey
                        ? h('p', { class: 'label-md', style: 'color: var(--secondary);' }, t('shareList.shared'))
                        : h('button', {
                            class: 'btn btn-secondary',
                            onclick: () => { closeDialog(); actions.shareList(listId) },
                        }, t('shareList.button')),
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
            ])
            queueMicrotask(() => nameInput.focus())
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
            ])
        } else if (kind === 'server-shutdown') {
            content = dialogFrame(t('desktop.servers.shutdown'), [
                h('p', { class: 'dialog-body warning' }, t('desktop.servers.shutdownConfirm', { name: ui.dialog.serverName })),
            ], [
                h('button', { class: 'btn btn-secondary', onclick: closeDialog }, t('common.cancel')),
                h('button', { class: 'btn btn-danger', onclick: () => shutdownServer(ui.dialog.serverKey) }, t('desktop.servers.shutdown')),
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
                ['[ ]', t('desktop.shortcuts.switchList')],
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
        } else if (kind === 'item-move') {
            const item = ui.dialog.item
            const rail = buildRail(state)
            const isCurrent = (s) => s.listId === item.listId && surfaceForType(s.type) === surfaceForType(item.listType)
            const typeGlyph = (type) => tablerIcon(isBoardType(type) ? 'layout-columns' : isTodoType(type) ? 'checklist' : 'basket', { size: 16 })
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
                if (ui.dialog.moveFrom) {
                    // Promote-into-board move: relocate the existing item (id
                    // preserved) and supply the rigor fields the form collected.
                    markLocalId(ui.dialog.moveFrom.id)
                    send(RPC_MOVE, {
                        item: ui.dialog.moveFrom,
                        targetListId: ui.dialog.targetListId,
                        targetListType: BOARD_WRITE_TYPE,
                        fields: { status: 'todo', description: desc, checklist, estimatedHours: hours, estimatedComplexity: complexity },
                    })
                } else {
                    markLocalText(desc)
                    send(RPC_ADD, { text: desc, listId: ui.activeListId, listType: BOARD_WRITE_TYPE, status: 'todo', description: desc, checklist, estimatedHours: hours, estimatedComplexity: complexity })
                }
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
        if (!(target instanceof HTMLElement)) return false
        // contentEditable surfaces (the WYSIWYG markdown/callout block editors)
        // are typing targets too — without this the global single-key shortcuts
        // (t→theme, ?→help, [ ]→switch list, n/g/… ) fire while the user is
        // typing into a block, flipping the theme or navigating away from the
        // ticket mid-edit. isContentEditable is also true for any node nested
        // inside an editable host, so a click into a child element still counts.
        return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
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
        } else if (event.key === '[' || event.key === ']') {
            // Move between rail surfaces in display order.
            event.preventDefault()
            const all = allSurfaces(buildRail(store.getState()))
            const i = all.findIndex(surfaceActive)
            const next = all[i + (event.key === ']' ? 1 : -1)]
            if (next) selectSurface(store.getState(), next)
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
    // Set of plan refs ('i:listId::itemId' / 'l:listId::type') with a live day,
    // recomputed once per render so item rows can show their flag state cheaply.
    let plannedRefs = new Set()
    function renderAll() {
        const state = store.getState()
        plannedRefs = new Set(reducePlan(state.items).keys())
        // Advertise this device's name once its writer key is known (roster).
        maybeAssertDeviceName()
        // Republish any localStorage-only built-in group placement to the synced
        // channel, once, after the base is writable.
        migrateBuiltinGroups()
        // Materialize the mandated default "general" group once we're writable.
        maybeEnsureGeneralGroup()
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

    // Live-ish monitoring: while the Peers & Devices pane is open (which now
    // hosts the Servers section), re-poll paired servers every 20s. Silent so an
    // in-flight poll doesn't flicker the dots; the busy guard in refreshServer
    // prevents overlap. One interval for the app's lifetime — cheap when hidden.
    if (ownerControl && typeof setInterval === 'function') {
        setInterval(() => { if (ui.view === 'peers') refreshAllServers({ silent: true }) }, SERVERS_POLL_MS)
    }
    return { renderAll, openDialog, closeDialog, actions }
}
