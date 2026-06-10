// Boots the embedded @listam/backend inside the Pear Desktop app and returns
// the connected client. Only imported when a Pear runtime is detected — the
// bare-* module graph does not resolve in a plain browser.
import fs from 'bare-fs'
import { join } from 'bare-path'
import URL from 'bare-url'
import { startBackend } from '@listam/backend'
import { createPearPlatform } from '@listam/backend/platform/pear'
import { createBackendChannel } from '@listam/client'
import { createFileSecretStore, prepareDesktopSecrets, persistDesktopSecret } from './secret-store.mjs'

export async function bootDesktopBackend({ Pear, onEvent }) {
    const storageDir = Pear?.config?.storage
    if (!storageDir) throw new Error('Pear storage directory unavailable')

    const secretStore = createFileSecretStore({
        fs,
        path: join(storageDir, 'listam-desktop-secrets.json'),
    })
    const prepared = await prepareDesktopSecrets(secretStore)

    const channel = createBackendChannel()
    const unsubscribe = channel.client.onEvent((event) => {
        if (event.type === 'persist-secret') {
            // Answer the backend's durable-write ack so key material never has
            // to live in backend-owned plaintext files.
            persistDesktopSecret(event.payload, secretStore)
                .then((result) => event.reply(JSON.stringify({ stored: result.mode === 'secure-store', mode: result.mode })))
                .catch(() => event.reply(JSON.stringify({ stored: false })))
            return
        }
        onEvent?.(event)
    })

    const platform = createPearPlatform({
        Pear,
        fs,
        join,
        fileURLToPath: URL.fileURLToPath,
        createRpc: channel.platform.createRpc,
        storageNamespace: 'desktop',
        bootSecretPayload: JSON.stringify(prepared.backendPayload),
    })

    const backend = await startBackend(platform)
    return {
        client: channel.client,
        secretsMode: prepared.mode,
        shutdown: backend.shutdown,
        dispose: unsubscribe,
    }
}
