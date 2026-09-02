// How a list TYPE maps onto the desktop: which pane renders it, which rail icon
// marks it, which localized name a built-in surface falls back to, and which
// items belong to it.
//
// These four were hard-coded "board? todo? otherwise grocery" chains inside
// ui.mjs, and the otherwise-branch is exactly why the notes type rendered as
// categorized grocery rows everywhere before it was added here. Keeping them in
// one place makes the seam visible — and testable: desktop tests have no DOM,
// and none of this needs one (same shape as ../registry.mjs, ../ticket.mjs).
import { isTodoType, isNotesType } from '@listam/domain/identity'
import { isBoardType } from '@listam/domain/board'
import { isRegistryItem } from '@listam/domain/list-registry'
import { isLabelItem } from '@listam/domain/labels'
import { isPlanItem } from '@listam/domain/plan'

// Map a list type to its pane/view key. System views sit outside this.
export const surfaceForType = (type) => (
    isBoardType(type) ? 'board' : isTodoType(type) ? 'todo' : isNotesType(type) ? 'notes' : 'lists'
)
export const iconForType = (type) => (
    isBoardType(type) ? 'layout-grid' : isTodoType(type) ? 'checklist' : isNotesType(type) ? 'notes' : 'shopping-cart'
)

// Grocery surfaces (the lists pane, its count, clear-done) operate on ordinary
// grocery list items only. Board tickets live on their own board, to-do items
// are plain text with no grocery intelligence, and notes are documents — all
// three are excluded so they are never shown, counted, categorized, or cleared
// alongside groceries. Each has its own dedicated surface when its list exists.
export function isGroceryItem(item) {
    // Registry meta-items (listType 'registry') describe lists/groups, not
    // grocery entries — they share state.items but must never render as rows.
    // (Board/to-do/notes are already excluded by type; registry is the one a
    // bare "not board, not todo" test would wrongly admit.)
    // Label meta-items (peer names, surface names) also share state.items but
    // live in their own listId buckets and must never render as grocery rows.
    //
    // Notes joined that list late and the omission was visible: the voice
    // notetaker has been writing real 'notes' items since the backend shipped
    // them, and every one of them rendered here as a categorized grocery row
    // because "not board, not todo" is TRUE for a note.
    return !!item && !isRegistryItem(item) && !isLabelItem(item) && !isPlanItem(item) && !isBoardType(item.listType) && !isTodoType(item.listType) && !isNotesType(item.listType)
}

// The to-do surface: plain text items (isTodoType), the mirror of isGroceryItem
// for the grocery surface and isBoardType for the board.
export function isTodoItem(item) {
    return !!item && isTodoType(item.listType)
}

// The notes surface: free-form documents (isNotesType), the same mirror again.
export function isNotesItem(item) {
    return !!item && isNotesType(item.listType)
}

// The localized default label key for a built-in surface type. Notes has no
// built-in surface (named lists only) but keys the same way, so a stray notes
// list is never labelled "Groceries" by the fallback.
export function builtinFallbackKey(type) {
    if (isBoardType(type)) return 'desktop.rail.board'
    if (isTodoType(type)) return 'desktop.rail.todo'
    if (isNotesType(type)) return 'desktop.rail.notes'
    return 'desktop.rail.groceries'
}

// Which items belong to a surface of this type. Grocery is the fallback, so it
// stays the negative test — see isGroceryItem for what that costs.
export function typePredicate(type) {
    if (isBoardType(type)) return (item) => isBoardType(item.listType)
    if (isTodoType(type)) return (item) => isTodoItem(item)
    if (isNotesType(type)) return (item) => isNotesItem(item)
    return (item) => isGroceryItem(item)
}
