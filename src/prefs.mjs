// UI preference persistence (theme, hint bar, view toggles) plus the theme
// controller. Preferences are local to this device and never replicated —
// same injected-storage pattern as the locale choice in i18n.mjs.
import { DEFAULT_PREFERENCES } from './store.mjs'
import { normalizeLeafBridgePort } from './leaf-bridge-config.mjs'

const UI_PREFS_KEY = 'listam.desktop.uiPreferences'

export const THEME_CHOICES = ['system', 'light', 'dark']

export function nextTheme(theme) {
    const index = THEME_CHOICES.indexOf(theme)
    return THEME_CHOICES[(index + 1) % THEME_CHOICES.length]
}

export function loadUiPreferences(storage) {
    try {
        const raw = storage?.getItem?.(UI_PREFS_KEY)
        if (!raw) return {}
        const parsed = JSON.parse(raw)
        const result = {}
        for (const [key, fallback] of Object.entries(DEFAULT_PREFERENCES)) {
            if (key === 'localeChoice') continue // owned by i18n.mjs
            if (typeof parsed?.[key] === typeof fallback) result[key] = parsed[key]
        }
        if (result.theme !== undefined && !THEME_CHOICES.includes(result.theme)) delete result.theme
        if (result.leafBridgePort !== undefined && normalizeLeafBridgePort(result.leafBridgePort) <= 0) {
            delete result.leafBridgePort
        }
        return result
    } catch {
        return {}
    }
}

export function persistUiPreferences(storage, preferences) {
    try {
        const { localeChoice, ...rest } = preferences
        storage?.setItem?.(UI_PREFS_KEY, JSON.stringify(rest))
        return true
    } catch {
        return false
    }
}

// Resolves the 'system' choice against the OS and keeps <html data-theme>
// pointing at a concrete palette ('light' | 'dark'), re-resolving when the
// OS scheme changes while the choice is 'system'.
export function createThemeController({ documentElement, matchMedia }) {
    const media = matchMedia ? matchMedia('(prefers-color-scheme: dark)') : null
    let choice = 'system'

    function apply(nextChoice = choice) {
        choice = THEME_CHOICES.includes(nextChoice) ? nextChoice : 'system'
        const resolved = choice === 'system' ? (media?.matches ? 'dark' : 'light') : choice
        documentElement.dataset.theme = resolved
        return resolved
    }

    media?.addEventListener?.('change', () => {
        if (choice === 'system') apply()
    })

    return { apply }
}
