// Presentational selectors and helpers for the kanban board. Pure (no DOM, no
// store), so ui.mjs stays a thin renderer and the math is unit-testable. The
// domain logic itself lives in @listam/domain/kanban — the same code the
// backend uses — and is re-exposed here through thin wrappers.
import {
    KANBAN_LIST_TYPE,
    DEFAULT_BOARD_CONFIG,
    normalizeBoardConfig,
    isKanbanTicket,
    computeCongruency,
    validateTicketDraft,
    msToHours,
} from '@listam/domain/kanban'

export { KANBAN_LIST_TYPE, DEFAULT_BOARD_CONFIG }

export function selectBoardConfig (state) {
    return normalizeBoardConfig(state?.boardConfig)
}

export function isTicket (item) {
    return isKanbanTicket(item)
}

export function selectTickets (items) {
    return (Array.isArray(items) ? items : []).filter(isKanbanTicket)
}

// Group tickets into board columns in the config's state order. Tickets with an
// unknown/missing status fall into the first column.
export function groupByStatus (items, config) {
    const cfg = normalizeBoardConfig(config)
    const states = cfg.states
    const firstId = states[0]?.id
    const byId = new Map(states.map((s) => [s.id, []]))
    for (const ticket of selectTickets(items)) {
        const status = byId.has(ticket.status) ? ticket.status : firstId
        if (byId.has(status)) byId.get(status).push(ticket)
    }
    return states.map((state) => ({ state, tickets: byId.get(state.id) || [] }))
}

// Everything a ticket card renders, including a live in-progress duration that
// extends an open timer to `now` (the stored inProgressMs only counts closed
// slices).
export function ticketBadges (item, now = Date.now()) {
    const checklist = Array.isArray(item?.checklist) ? item.checklist : []
    let inProgressMs = typeof item?.inProgressMs === 'number' ? item.inProgressMs : 0
    if (item?.status === 'in_progress' && typeof item?.inProgressSince === 'number') {
        inProgressMs += Math.max(0, now - item.inProgressSince)
    }
    return {
        priority: item?.priority || null,
        assignee: item?.assignee || item?.createdBy || null,
        dueAt: typeof item?.dueAt === 'number' ? item.dueAt : null,
        checklistDone: checklist.filter((t) => t && t.done).length,
        checklistTotal: checklist.length,
        inProgressMs,
        inProgressHours: msToHours(inProgressMs),
        estimatedHours: typeof item?.estimatedHours === 'number' ? item.estimatedHours : null,
        timeliness: item?.timeliness || null,
        isDone: !!item?.isDone,
        running: item?.status === 'in_progress',
    }
}

export function selectWriterStats (items) {
    return computeCongruency(selectTickets(items))
}

export function validateRigorDraft (draft, config) {
    return validateTicketDraft(draft, normalizeBoardConfig(config))
}

// Build the single RPC_UPDATE payload a drag/status change emits. Returns null
// for a no-op (same column). updatedAt is always bumped so the LWW reducer never
// drops the move; the backend computes the time/timeliness fields from this.
export function buildStatusChange (item, status, now = Date.now()) {
    if (!item || item.status === status) return null
    return { ...item, status, updatedAt: now }
}

// "4h 12m" / "37m" — compact in-progress / elapsed display.
export function formatDuration (ms) {
    const totalMin = Math.max(0, Math.round((typeof ms === 'number' ? ms : 0) / 60000))
    const h = Math.floor(totalMin / 60)
    const m = totalMin % 60
    return h > 0 ? `${h}h ${m}m` : `${m}m`
}

// Percentage delta of actual vs estimate, signed, for the on-time/overtime
// badge label (e.g. "+28%", "-35%"). null when there is no estimate.
export function deltaPercent (actualHours, estimatedHours) {
    if (!(typeof estimatedHours === 'number' && estimatedHours > 0)) return null
    return Math.round(((actualHours - estimatedHours) / estimatedHours) * 100)
}

// ---------------------------------------------------------------------------
// Block-based ticket body
//
// A ticket carries an optional `blocks: [{id, type, ...payload}]` array (the
// field already exists in the domain types). The editor edits each block as
// raw text and renders a formatted view on blur, so a single robust textarea
// pattern covers all eight types — the parse/serialize logic below is pure and
// unit-testable, and the markdown renderer is XSS-safe.
// ---------------------------------------------------------------------------

// Order + icon + i18n label for the "/" insert menu.
export const BLOCK_TYPES = [
    { type: 'markdown', icon: 'align-left', labelKey: 'ticket.block.type.markdown' },
    { type: 'checklist', icon: 'checklist', labelKey: 'ticket.block.type.checklist' },
    { type: 'numberedList', icon: 'list-numbers', labelKey: 'ticket.block.type.numberedList' },
    { type: 'links', icon: 'link', labelKey: 'ticket.block.type.links' },
    { type: 'image', icon: 'photo', labelKey: 'ticket.block.type.image' },
    { type: 'table', icon: 'table', labelKey: 'ticket.block.type.table' },
    { type: 'callout', icon: 'quote', labelKey: 'ticket.block.type.callout' },
    { type: 'code', icon: 'code', labelKey: 'ticket.block.type.code' },
]

const BLOCK_TYPE_SET = new Set(BLOCK_TYPES.map((b) => b.type))

export function isBlockType (type) {
    return BLOCK_TYPE_SET.has(type)
}

export function normalizeBlocks (blocks) {
    return (Array.isArray(blocks) ? blocks : []).filter((b) => b && isBlockType(b.type) && typeof b.id === 'string')
}

// A freshly-inserted, empty block of the given type.
export function createBlock (type, id) {
    const base = { id, type: isBlockType(type) ? type : 'markdown' }
    switch (base.type) {
        case 'checklist': return { ...base, items: [{ text: '', done: false }] }
        case 'numberedList': return { ...base, items: [{ text: '' }] }
        case 'links': return { ...base, links: [{ label: '', url: '' }] }
        case 'image': return { ...base, url: '', alt: '' }
        case 'table': return { ...base, rows: [['', ''], ['', '']] }
        case 'callout': return { ...base, text: '', tone: 'info' }
        case 'code': return { ...base, text: '', lang: '' }
        default: return { ...base, text: '' }
    }
}

// Serialize a block to the raw text shown in its edit textarea.
export function blockToText (block) {
    if (!block) return ''
    switch (block.type) {
        case 'checklist':
            return (block.items || []).map((it) => `[${it.done ? 'x' : ' '}] ${it.text || ''}`.trimEnd()).join('\n')
        case 'numberedList':
            return (block.items || []).map((it) => it.text || '').join('\n')
        case 'links':
            return (block.links || []).map((l) => `${l.label || ''} | ${l.url || ''}`.trim()).join('\n')
        case 'image':
            return [block.url || '', block.alt || ''].join('\n').replace(/\n$/, '')
        case 'table':
            return (block.rows || []).map((row) => (row || []).join(', ')).join('\n')
        default:
            return block.text || ''
    }
}

// Parse the raw textarea value back into a block payload patch (the inverse of
// blockToText). Returns the fields to merge onto the block (never the id/type).
export function blockFromText (type, text) {
    const raw = typeof text === 'string' ? text : ''
    const lines = raw.split('\n')
    switch (type) {
        case 'checklist':
            return {
                items: lines
                    .filter((line) => line.trim() !== '')
                    .map((line) => {
                        const match = line.match(/^\s*\[( |x|X)\]\s?(.*)$/)
                        return match
                            ? { text: match[2], done: match[1].toLowerCase() === 'x' }
                            : { text: line.trim(), done: false }
                    }),
            }
        case 'numberedList':
            return {
                items: lines
                    .map((line) => line.replace(/^\s*(\d+[.)]|[-*])\s+/, '').trim())
                    .filter((t) => t !== '')
                    .map((t) => ({ text: t })),
            }
        case 'links':
            return {
                links: lines
                    .filter((line) => line.trim() !== '')
                    .map((line) => {
                        const [label, url] = line.split('|')
                        return { label: (label || '').trim(), url: (url || '').trim() }
                    }),
            }
        case 'image':
            return { url: (lines[0] || '').trim(), alt: lines.slice(1).join(' ').trim() }
        case 'table':
            return {
                rows: lines
                    .filter((line) => line.trim() !== '')
                    .map((line) => line.split(',').map((cell) => cell.trim())),
            }
        default:
            return { text: raw }
    }
}

const SAFE_LINK = /^(https?:\/\/|mailto:)/i

export function escapeHtml (value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    ))
}

// Minimal, XSS-safe inline markdown -> HTML string. Escapes first, then layers
// a whitelisted subset: `code`, **bold**, *italic*, [label](url) (http/https/
// mailto only), and newlines as <br>. The output is always built from escaped
// text, so the result is safe to assign to innerHTML.
export function renderInlineMarkdown (text) {
    let out = escapeHtml(text)
    out = out.replace(/`([^`]+)`/g, (_m, code) => `<code>${code}</code>`)
    out = out.replace(/\*\*([^*]+)\*\*/g, (_m, bold) => `<strong>${bold}</strong>`)
    out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, (_m, pre, em) => `${pre}<em>${em}</em>`)
    out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, url) => {
        // The url here is already HTML-escaped; validate the (unescaped form of
        // the) scheme before emitting an anchor.
        const decoded = url.replace(/&amp;/g, '&')
        if (!SAFE_LINK.test(decoded)) return match
        return `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`
    })
    return out.replace(/\n/g, '<br>')
}
