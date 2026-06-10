// Desktop secret persistence behind the shared @listam/secrets boundary.
//
// The plan's desktop target is the OS keychain; Pear's renderer has no
// keychain bridge yet, so this adapter stores the backend key material in a
// single JSON file under the app's private storage directory with owner-only
// permissions. That is the documented dev/file tier (the UI surfaces the
// 'backend.secureStorage.legacy' notice) — the keychain upgrade is recorded
// as Phase 13/14 follow-up work. The adapter shape is identical to mobile's
// SecureStore one, so the shared prepare/persist flows are reused unchanged.
import { persistBackendSecretRequest, prepareBackendSecrets } from '@listam/secrets'

export function createFileSecretStore({ fs, path }) {
    if (!fs || !path) throw new Error('A filesystem adapter and file path are required')

    function readAll() {
        try {
            const parsed = JSON.parse(fs.readFileSync(path, 'utf8'))
            return parsed && typeof parsed === 'object' ? parsed : {}
        } catch {
            return {}
        }
    }

    function writeAll(values) {
        fs.writeFileSync(path, JSON.stringify(values), { mode: 0o600 })
    }

    return {
        async isAvailable() {
            return true
        },
        async getItem(key) {
            const values = readAll()
            return typeof values[key] === 'string' ? values[key] : null
        },
        async setItem(key, value) {
            const values = readAll()
            values[key] = String(value)
            writeAll(values)
        },
        async deleteItem(key) {
            const values = readAll()
            if (!(key in values)) return
            delete values[key]
            writeAll(values)
        },
    }
}

// Boot-time: read the stored key material and build the backend boot payload
// (argv[3]) exactly the way the mobile adapter does.
export async function prepareDesktopSecrets(secretStore) {
    return prepareBackendSecrets({ secureStore: secretStore })
}

// Runtime: answer the backend's RPC_PERSIST_SECRET requests. The ack is what
// lets the backend trust the write and keep keys out of its own files.
export async function persistDesktopSecret(rawPayload, secretStore) {
    return persistBackendSecretRequest(rawPayload, { secureStore: secretStore })
}
