// Escape is handled before this policy so it can always close the topmost
// surface. Every other app-wide shortcut is suspended while a drawer is open:
// drawer editors own the keyboard until the user explicitly closes the drawer.
export function shouldHandleAppShortcut ({
    drawerOpen = false,
    dialogOpen = false,
    typingTarget = false,
    commandPaletteKey = false,
} = {}) {
    if (drawerOpen) return false
    if (commandPaletteKey) return true
    return !dialogOpen && !typingTarget
}

// Is this element somewhere a keystroke means TEXT rather than a command?
//
// Nearly every app shortcut here is a bare letter (t→theme, n→add, g→grid,
// h→hints, ?→help, f→flag, [ ]→switch surface), so getting this wrong does not
// merely add a shortcut — it eats the character AND flips the theme or navigates
// away from what is being typed.
//
// Duck-typed on tagName rather than `instanceof HTMLElement` so it also holds
// for `document`, text nodes and null, and so desktop's DOM-less node tests can
// exercise it directly.
export function isTypingTarget (target) {
    if (!target || typeof target.tagName !== 'string') return false
    const tag = target.tagName.toUpperCase()
    // SELECT is here because typing into a focused dropdown is how you jump to
    // an option — those letters are not shortcuts either.
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
    // contentEditable covers the WYSIWYG markdown/callout block editors.
    // isContentEditable is true for any node nested inside an editable host too,
    // so a click into a child element still counts.
    return target.isContentEditable === true
}

// A keystroke counts as typing when EITHER the event target or the focused
// element is a field. They normally agree; they come apart in exactly the case
// that hurts — this renderer rebuilds surfaces wholesale, so a background
// re-render can detach the field mid-word and retarget the event to <body> while
// focus is already restored on the rebuilt field.
export function isTypingKeystroke (event, activeElement) {
    return isTypingTarget(event?.target) || isTypingTarget(activeElement)
}
