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
