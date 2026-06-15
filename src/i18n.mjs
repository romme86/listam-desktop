// Desktop locale wiring over the shared @listam/i18n catalogs (Phase 9).
// Locale choice is a local UI preference: persisted via an injected storage,
// never replicated.
import {
    createI18n,
    isLocaleChoice,
    LOCALE_CHOICES as SHARED_LOCALE_CHOICES,
    LOCALE_LABEL_KEYS,
} from '@listam/i18n'

const LOCALE_PREF_KEY = 'listam.desktop.localeChoice'

export function loadLocaleChoice(storage) {
    try {
        const stored = storage?.getItem?.(LOCALE_PREF_KEY)
        return isLocaleChoice(stored) ? stored : 'system'
    } catch {
        return 'system'
    }
}

export function persistLocaleChoice(storage, choice) {
    if (!isLocaleChoice(choice)) return false
    try {
        storage?.setItem?.(LOCALE_PREF_KEY, choice)
        return true
    } catch {
        return false
    }
}

export function buildI18n(localeChoice, systemLocale) {
    return createI18n({ localeChoice, systemLocale })
}

// Mirror the shared catalog's locale list so newly added UI languages
// (de/fr/it/pt and any future ones) appear in the picker automatically,
// instead of drifting from @listam/i18n.
export const LOCALE_CHOICES = SHARED_LOCALE_CHOICES

export function localeChoiceLabel(i18n, choice) {
    return i18n.t(LOCALE_LABEL_KEYS[choice] ?? 'app.locale.system')
}
