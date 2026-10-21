// The ticket create panel's decision logic — everything about the panel that is
// not markup.
//
// The panel used to hold its fields in a throwaway object and hand them to one
// submit. Every other way of leaving it — a click on the backdrop, the global
// Escape handler, a background render that swapped the dialog — took the
// half-written ticket with it. So the panel no longer HOLDS a ticket, it OPENS
// one: a real row exists from the moment the panel does, and the fields edit it
// in place (see buildDraftTicket in @listam/domain/board).
//
// The interesting question is no longer what a submit builds; it is what a
// DISMISSAL means. That is decided here rather than at the call site — three
// outcomes, one of which deletes a row, so it is worth being able to test
// without a DOM. ui.mjs keeps only the wiring: the RPC send, the local-echo
// marking, the debounce timer.
import { validateRigorDraft } from '../ticket.mjs'
import { normalizeBoardConfig } from '@listam/domain/board'
import { validateValueDraft } from '@listam/domain/value'
import { seedTicketTasks } from './ticket-body.mjs'

// The one field an empty panel does not start blank. Also the marker for
// "nothing was touched": a complexity still sitting on the default means the
// user never moved the slider.
export const TICKET_DRAFT_COMPLEXITY = 50

/** The panel state a brand-new ticket opens with. */
export function emptyTicketDraft () {
    return {
        description: '',
        tasks: [''],
        hours: '',
        complexity: TICKET_DRAFT_COMPLEXITY,
        valueRate: null,
        delayRate: null,
    }
}

/** The panel state for RESUMING an unfinished draft from its live row. */
export function ticketDraftFromItem (item) {
    const checklist = Array.isArray(item?.checklist) ? item.checklist : []
    return {
        description: item?.description || item?.text || '',
        tasks: checklist.length ? checklist.map((task) => task?.text ?? '') : [''],
        hours: item?.estimatedHours ? String(item.estimatedHours) : '',
        complexity: Number.isFinite(item?.estimatedComplexity) ? item.estimatedComplexity : TICKET_DRAFT_COMPLEXITY,
        valueRate: item?.valueRate ?? null,
        delayRate: item?.delayRate ?? null,
    }
}

// Index-keyed task ids: the checklist is rewritten wholesale from the panel on
// every save, so an id derived from the text (as the old one-shot submit did)
// would change on every keystroke.
export function ticketDraftChecklist (draft) {
    return (draft?.tasks ?? [])
        .map((text, index) => ({ id: `task-${index}`, text: String(text ?? '').trim(), done: false }))
        .filter((task) => task.text)
}

/** The panel's fields as ticket fields. `text` is the board card's title. */
export function ticketDraftFields (draft, valueOn, blocks = []) {
    const description = String(draft?.description ?? '').trim()
    const hours = Number(draft?.hours)
    const complexity = Number(draft?.complexity)
    const checklist = ticketDraftChecklist(draft)
    const fields = {
        text: description,
        description,
        checklist,
        blocks: seedTicketTasks(checklist, blocks),
        estimatedHours: Number.isFinite(hours) && hours > 0 ? hours : 0,
        estimatedComplexity: Number.isFinite(complexity) ? complexity : TICKET_DRAFT_COMPLEXITY,
    }
    if (valueOn) {
        fields.valueRate = draft?.valueRate ?? null
        fields.delayRate = draft?.delayRate ?? null
    }
    return fields
}

// Everything the panel refuses to finish on, in the order the fields appear: a
// description always, the rigor set when rigor is on, the value rates when the
// destination surface rates its items.
export function ticketDraftMissing (draft, config, valueOn) {
    const cfg = normalizeBoardConfig(config)
    const description = String(draft?.description ?? '').trim()
    const missing = []
    if (!description) missing.push('description')
    if (cfg.rigorOn) {
        const candidate = {
            text: description,
            description,
            checklist: ticketDraftChecklist(draft),
            estimatedHours: Number(draft?.hours),
            estimatedComplexity: Number(draft?.complexity),
        }
        for (const m of validateRigorDraft(candidate, cfg).missing) {
            if (!missing.includes(m)) missing.push(m)
        }
    }
    if (valueOn) {
        for (const m of validateValueDraft({ valueRate: draft?.valueRate, delayRate: draft?.delayRate }).missing) {
            if (!missing.includes(m)) missing.push(m)
        }
    }
    return missing
}

// Nothing was typed and no control was moved. Pressing + and changing your mind
// must not litter the board with blank cards, so this row is removed rather than
// kept — there is no work in it to preserve.
export function isUntouchedTicketDraft (draft) {
    return !String(draft?.description ?? '').trim()
        && !(draft?.tasks ?? []).some((task) => String(task ?? '').trim())
        && !(Number(draft?.hours) > 0)
        && draft?.valueRate == null
        && draft?.delayRate == null
        && Number(draft?.complexity) === TICKET_DRAFT_COMPLEXITY
}

/**
 * What a dismissal of the panel means for the row it opened.
 *
 *   'none'   — the row is gone, or was already committed by the button
 *   'delete' — untouched: remove it rather than leave a blank card behind
 *   'commit' — complete: closing a finished panel any way you like finishes the
 *              ticket, so clicking away is never a way to lose the last field
 *   'keep'   — incomplete: it stays a draft — amber on the board, pinned in its
 *              column, reopened by a click on the card
 *
 * `isDraft` is passed in rather than read off the item so this stays free of the
 * board module's shape checks; ui.mjs supplies isDraftTicket(item).
 */
export function planTicketDraftSettlement ({ item, draft, config, valueOn = false, isDraft = false }) {
    if (!item) return 'none'
    if (isUntouchedTicketDraft(draft)) return 'delete'
    if (!isDraft) return 'none'
    return ticketDraftMissing(draft, config, valueOn).length ? 'keep' : 'commit'
}
