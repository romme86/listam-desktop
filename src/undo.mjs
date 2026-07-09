// Pure, framework-free helpers for the desktop undo stack (Ship 1: delete /
// edit / toggle). Undo is a NEW forward inverse write stamped now() — never a
// log rewind — because the store is a pure last-write-wins projection of backend
// events (no optimistic cache). Keeping this logic out of ui.mjs makes it unit-
// testable with node:test and avoids any @listam import (so no index.html
// importmap entry is needed).

/**
 * @typedef {'edit'|'toggle'|'delete'} UndoKind
 * @typedef {Object} UndoEntry
 * @property {UndoKind} kind
 * @property {string}   itemId    the affected item's id
 * @property {Object}   preImage  full item snapshot BEFORE the gesture (the inverse content)
 * @property {Object}   touched   the field values the FORWARD write produced (for the guard)
 */

/**
 * Build a frozen undo entry. `touched` MUST be derived from the forward payload
 * (not read back from the store), because the store still holds the pre-gesture
 * value at capture time — there is no optimistic cache to read the post-gesture
 * value from.
 * @param {{kind:UndoKind,itemId:string,preImage:Object,touched?:Object}} spec
 * @returns {UndoEntry}
 */
/**
 * Push an entry onto a bounded stack (mutates in place), evicting the oldest
 * entries when it would exceed `cap`. Returns the stack.
 * @template T
 * @param {T[]} stack
 * @param {T} entry
 * @param {number} cap
 * @returns {T[]}
 */
export function pushCapped(stack, entry, cap) {
    stack.push(entry)
    while (stack.length > cap) stack.shift()
    return stack
}

export function buildUndoEntry({ kind, itemId, preImage, touched = {} }) {
    return Object.freeze({
        kind,
        itemId,
        preImage: { ...preImage },
        touched: { ...touched },
    })
}

/**
 * The inverse write for an entry, ready to hand to send(). `updatedAt` is stamped
 * at APPLY time (`now`) so the inverse wins the last-write-wins merge against the
 * very write being undone. For every Ship-1 kind the inverse is a full-item
 * RPC_UPDATE restoring the pre-image — delete included: a deleted item is
 * resurrected by re-writing it under its ORIGINAL id, never via RPC_ADD (which
 * would mint a new id and leave the tombstone standing).
 * @param {UndoEntry} entry
 * @param {number} now        apply-time timestamp
 * @param {number} rpcUpdate  the RPC_UPDATE command id
 * @returns {{command:number, payload:{item:Object}}}
 */
export function applyInverseWrite(entry, now, rpcUpdate) {
    return {
        command: rpcUpdate,
        payload: { item: { ...entry.preImage, updatedAt: now } },
    }
}

/**
 * Content-fingerprint guard: is it still safe to apply this entry's inverse?
 * Compares the fields the gesture TOUCHED against the current item, so multi-
 * level undo of the SAME item chains correctly — an `updatedAt`-equality check
 * would break after the first undo bumps `updatedAt` to a fresh now(). Returns
 * false when the target has moved underneath us (a remote / other-surface change
 * we can already see).
 *
 * Honest limitation: this is drift DETECTION for already-visible changes only.
 * Scalar-clock LWW cannot detect an un-replicated concurrent edit, so undo may
 * still silently override one; that is inherent to the data model, not a bug
 * this guard can close.
 *
 * @param {UndoEntry} entry
 * @param {(id:string)=>(Object|undefined|null)} lookup  current item by id
 * @returns {boolean}
 */
export function guardOk(entry, lookup) {
    const cur = lookup(entry.itemId)
    if (entry.kind === 'delete') {
        // We deleted it; undo resurrects. Refuse if it is live again (someone
        // re-created it, or a concurrent write already beat the tombstone).
        return !cur
    }
    if (!cur) return false // edit/toggle target vanished (a remote delete)
    for (const key of Object.keys(entry.touched)) {
        if (cur[key] !== entry.touched[key]) return false
    }
    return true
}
