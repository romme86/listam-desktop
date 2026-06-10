// Desktop secret persistence behind the shared @listam/secrets boundary.
//
// The plan's desktop target is the OS keychain; Pear's renderer has no
// keychain bridge yet, so the shared file store keeps the backend key
// material in one owner-only JSON file under the app's private storage
// directory. That is the documented dev/file tier (the UI surfaces the
// 'backend.secureStorage.legacy' notice) — the keychain upgrade is recorded
// as follow-up work. The adapter shape is identical to mobile's SecureStore
// one, so the shared prepare/persist flows are reused unchanged.
import { createFileSecretStore, persistBackendSecretRequest, prepareBackendSecrets } from '@listam/secrets'

export { createFileSecretStore }

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
