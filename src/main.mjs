// Desktop entry point. Under Pear the embedded @listam/backend is booted
// in-process; in a plain browser (design preview, ?mock=1) a fixture backend
// stands in. Everything downstream — store, i18n, UI — is identical.
import { RPC_REQUEST_SYNC, RPC_GET_MEMBERS, RPC_CREATE_INVITE } from '@listam/protocol'
import { createLogger } from '@listam/logging'
import { createDesktopStore } from './store.mjs'
import { buildI18n, loadLocaleChoice, persistLocaleChoice } from './i18n.mjs'
import { loadUiPreferences, persistUiPreferences, createThemeController } from './prefs.mjs'
import { mountApp } from './ui.mjs'
import { createMockBackend } from './mock-backend.mjs'

const root = document.getElementById('app')
const storage = globalThis.localStorage
const systemLocale = globalThis.navigator?.language || 'en'
const log = createLogger({ app: 'desktop' })

const store = createDesktopStore({
    preferences: { ...loadUiPreferences(storage), localeChoice: loadLocaleChoice(storage) },
})

// Theme + UI preference persistence: resolve 'system' against the OS, keep
// <html data-theme> in sync, and write preference changes back to storage.
const theme = createThemeController({
    documentElement: document.documentElement,
    matchMedia: globalThis.matchMedia?.bind(globalThis),
})
theme.apply(store.getState().preferences.theme)

let lastPreferences = store.getState().preferences
store.subscribe((state) => {
    if (state.preferences === lastPreferences) return
    lastPreferences = state.preferences
    persistUiPreferences(storage, state.preferences)
    theme.apply(state.preferences.theme)
})

const locale = {
    choice: store.getState().preferences.localeChoice,
    i18n: buildI18n(store.getState().preferences.localeChoice, systemLocale),
    setChoice(choice) {
        locale.choice = choice
        locale.i18n = buildI18n(choice, systemLocale)
        persistLocaleChoice(storage, choice)
        store.setPreferences({ localeChoice: choice })
    },
}

async function boot() {
    const isPear = typeof globalThis.Pear !== 'undefined' && globalThis.Pear?.config
    const onEvent = (event) => store.applyClientEvent(event, Date.now())

    if (isPear) {
        const { bootDesktopBackend } = await import('./backend-boot.mjs')
        const backend = await bootDesktopBackend({
            Pear: globalThis.Pear,
            onEvent,
            onBridgeStatus: (status) => store.setState({ leafBridge: status }),
            onVoiceStatus: (status) => store.setState({ voice: status }),
        })
        store.setState({ backendReady: true })
        if (backend.secretsMode !== 'secure-store') {
            store.pushNotice(locale.i18n.t('backend.secureStorage.legacy'), 'info')
        }
        // Owner-control needs hyperdht (bare graph) — like the backend it
        // cannot load in the renderer. Until it gets its own worker bridge,
        // failure here must not take the backend down with it.
        const ownerControl = await import('./owner-control.mjs')
            .then(({ createOwnerControlManager }) => createOwnerControlManager({ Pear: globalThis.Pear }))
            .catch(() => null)
        mountApp({ root, store, client: backend.client, locale, ownerControl })
        // The backend emits its initial sync/invite during startup, before the
        // UI listener attaches; ask again now that we are listening.
        await backend.client.send(RPC_REQUEST_SYNC)
        await backend.client.send(RPC_GET_MEMBERS)
        await backend.client.send(RPC_CREATE_INVITE)
        // Leaf-board bridge (Settings → leaf board): resume the TCP listener
        // when the user left it enabled. Failures surface via leafBridge.error
        // in the settings dialog rather than blocking boot.
        const prefs = store.getState().preferences
        if (prefs.leafBridgeEnabled) {
            backend.client.bridge('start', { port: prefs.leafBridgePort })
                .then((status) => { if (status) store.setState({ leafBridge: status }) })
                .catch((error) => log.error('[listam] leaf-bridge auto-start failed', { message: error?.message }))
        }
        // Desktop-hosted voice: resume the audio bridge + whisper pipeline when
        // the user left voice enabled with a model configured. Items land in this
        // base directly; errors surface via state.voice.error in Settings.
        if (prefs.voiceEnabled && prefs.voiceModelPath) {
            // Force whisper's -l from the resolved UI locale (en/es/de/fr/it/pt)
            // unless the user pinned a specific voice language. Without a forced
            // locale whisper auto-detects per clip and mishears short Italian
            // commands ("aggiungi pane") as English, adding the item in English.
            // Sentinels: '' = track UI locale (default); 'auto' = real whisper
            // auto-detect; any other value = that forced language.
            const voiceLocale = prefs.voiceLocale && prefs.voiceLocale !== ''
                ? prefs.voiceLocale
                : locale.i18n.locale
            backend.client.voice('start', {
                modelPath: prefs.voiceModelPath,
                locale: voiceLocale,
                prompt: prefs.voicePrompt,
            })
                .then((status) => { if (status) store.setState({ voice: status }) })
                .catch((error) => log.error('[listam] voice auto-start failed', { message: error?.message }))
        }
        return
    }

    const mock = createMockBackend()
    mock.client.onEvent(onEvent)
    mock.client.onBridgeStatus((status) => store.setState({ leafBridge: status }))
    store.setState({ backendReady: true })
    mountApp({ root, store, client: mock.client, locale })
    mock.start()
    // Design-preview handle (mock boot only, never under Pear): lets browser
    // automation drive store events (e.g. simulate backend messages) to verify
    // UI states the fixtures can't reach.
    globalThis.__listamPreview = { store, client: mock.client }
}

boot().catch((error) => {
    log.error('[listam] backend boot failed', { message: error?.message ?? String(error), stack: error?.stack })
    store.setState({ bootError: error?.message ?? String(error) })
    store.pushNotice(`${locale.i18n.t('backend.startFailed')} (${error?.message ?? error})`, 'error')
    mountApp({ root, store, client: { send: async () => null, onEvent: () => () => {}, isConnected: () => false }, locale })
}).finally(() => {
    // Renderer-environment probe (visible with ELECTRON_ENABLE_LOGGING=1):
    // catches webview quirks like forced-colors backplates or a stale theme.
    requestAnimationFrame(() => {
        const probe = (query) => globalThis.matchMedia?.(query)?.matches ?? null
        const bg = (selector) => {
            const el = document.querySelector(selector)
            return el ? getComputedStyle(el).backgroundColor : null
        }
        const snapshot = store.getState()
        log.info('[listam] env', {
            backendReady: snapshot.backendReady,
            bootError: snapshot.bootError ?? null,
            items: snapshot.items.length,
            peerCount: snapshot.peerCount,
            pearCtrl: Boolean(globalThis.customElements?.get('pear-ctrl')),
            theme: document.documentElement.dataset.theme,
            prefersDark: probe('(prefers-color-scheme: dark)'),
            forcedColors: probe('(forced-colors: active)'),
            invertedColors: probe('(inverted-colors: inverted)'),
            prefersContrastMore: probe('(prefers-contrast: more)'),
            bodyBg: bg('body'),
            sidebarBg: bg('.sidebar'),
            navBg: bg('.nav-item:not(.active)'),
            navActiveBg: bg('.nav-item.active'),
            ua: navigator.userAgent,
        })
    })
})
