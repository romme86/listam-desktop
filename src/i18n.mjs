// Desktop locale wiring over the shared @listam/i18n catalogs (Phase 9).
// Locale choice is a local UI preference: persisted via an injected storage,
// never replicated.
import { createI18n, isLocaleChoice } from '@listam/i18n'

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

export const LOCALE_CHOICES = ['system', 'en', 'es', 'en-XA', 'en-XL']

export function localeChoiceLabel(i18n, choice) {
    switch (choice) {
        case 'en': return i18n.t('app.locale.english')
        case 'es': return i18n.t('app.locale.spanish')
        case 'en-XA': return i18n.t('app.locale.pseudo')
        case 'en-XL': return i18n.t('app.locale.long')
        default: return i18n.t('app.locale.system')
    }
}
