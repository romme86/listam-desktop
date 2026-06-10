// Desktop entry point. Under Pear the embedded @listam/backend is booted
// in-process; in a plain browser (design preview, ?mock=1) a fixture backend
// stands in. Everything downstream — store, i18n, UI — is identical.
import { RPC_REQUEST_SYNC, RPC_GET_MEMBERS, RPC_CREATE_INVITE } from '@listam/protocol'
import { createDesktopStore } from './store.mjs'
import { buildI18n, loadLocaleChoice, persistLocaleChoice } from './i18n.mjs'
import { mountApp } from './ui.mjs'
import { createMockBackend } from './mock-backend.mjs'

const root = document.getElementById('app')
const storage = globalThis.localStorage
const systemLocale = globalThis.navigator?.language || 'en'

const store = createDesktopStore({
    preferences: { localeChoice: loadLocaleChoice(storage) },
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
        const backend = await bootDesktopBackend({ Pear: globalThis.Pear, onEvent })
        store.setState({ backendReady: true })
        if (backend.secretsMode !== 'secure-store') {
            store.pushNotice(locale.i18n.t('backend.secureStorage.legacy'), 'info')
        }
        mountApp({ root, store, client: backend.client, locale })
        // The backend emits its initial sync/invite during startup, before the
        // UI listener attaches; ask again now that we are listening.
        await backend.client.send(RPC_REQUEST_SYNC)
        await backend.client.send(RPC_GET_MEMBERS)
        await backend.client.send(RPC_CREATE_INVITE)
        return
    }

    const mock = createMockBackend()
    mock.client.onEvent(onEvent)
    store.setState({ backendReady: true })
    mountApp({ root, store, client: mock.client, locale })
    mock.start()
}

boot().catch((error) => {
    store.pushNotice(`${locale.i18n.t('backend.startFailed')} (${error?.message ?? error})`, 'error')
    mountApp({ root, store, client: { send: async () => null, onEvent: () => () => {}, isConnected: () => false }, locale })
})
