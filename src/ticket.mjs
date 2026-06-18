// Presentational selectors and helpers for the board. The board + ticket logic
// (status grouping, badges, block parse/serialize) lives in @listam/domain/board
// — the same pure code the backend and the mobile app use — and is re-exposed
// here, alongside the desktop-only HTML inline-markdown renderer.
import {
    BOARD_LIST_TYPE,
    BOARD_WRITE_TYPE,
    DEFAULT_BOARD_CONFIG,
    normalizeBoardConfig,
    isBoardType,
    isBoardTicket,
    computeCongruency,
    validateTicketDraft,
    selectTickets,
    groupByStatus,
    ticketBadges,
    buildStatusChange,
    formatDuration,
    deltaPercent,
    BLOCK_TYPES,
    isBlockType,
    normalizeBlocks,
    createBlock,
    blockToText,
    blockFromText,
} from '@listam/domain/board'
import {
    markdownToHtml,
    htmlToMarkdown,
    inlineMarkdownToHtml,
} from '@listam/domain/markdown'

export {
    markdownToHtml,
    htmlToMarkdown,
    inlineMarkdownToHtml,
    BOARD_LIST_TYPE,
    BOARD_WRITE_TYPE,
    DEFAULT_BOARD_CONFIG,
    isBoardType,
    selectTickets,
    groupByStatus,
    ticketBadges,
    buildStatusChange,
    formatDuration,
    deltaPercent,
    BLOCK_TYPES,
    isBlockType,
    normalizeBlocks,
    createBlock,
    blockToText,
    blockFromText,
}

export function selectBoardConfig (state) {
    return normalizeBoardConfig(state?.boardConfig)
}

export function isTicket (item) {
    return isBoardTicket(item)
}

export function selectWriterStats (items) {
    return computeCongruency(selectTickets(items))
}

export function validateRigorDraft (draft, config) {
    return validateTicketDraft(draft, normalizeBoardConfig(config))
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
// Block-level markdown rendering now lives in the shared bridge as
// markdownToHtml (re-exported above); renderInlineMarkdown stays as the inline-
// only renderer for callout views.
