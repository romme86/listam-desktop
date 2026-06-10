import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPersistSecretPayload } from '@listam/secrets'
import { createFileSecretStore, prepareDesktopSecrets, persistDesktopSecret } from '../src/secret-store.mjs'

test('desktop secret store round-trips backend key material through the shared boundary', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'listam-desk-secrets-'))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const path = join(dir, 'secrets.json')
    const secretStore = createFileSecretStore({ fs, path })

    // First boot: nothing stored yet.
    const empty = await prepareDesktopSecrets(secretStore)
    assert.equal(empty.mode, 'secure-store')
    assert.deepEqual(empty.backendPayload.secrets ?? {}, {})

    // The backend persists its autobase key through RPC_PERSIST_SECRET.
    const keyHex = 'ab'.repeat(32)
    const payload = createPersistSecretPayload('autobaseKey', Buffer.from(keyHex, 'hex'))
    const persisted = await persistDesktopSecret(JSON.stringify(payload), secretStore)
    assert.equal(persisted.mode, 'secure-store')

    // Next boot hands the key back to the backend via the boot payload.
    const reloaded = await prepareDesktopSecrets(secretStore)
    assert.equal(reloaded.backendPayload.secrets.autobaseKey, keyHex)

    // The file is owner-only and the store deletes cleanly.
    assert.equal(statSync(path).mode & 0o077, 0)
    await secretStore.deleteItem(Object.keys(JSON.parse(readFileSync(path, 'utf8')))[0])
})

test('a corrupt secrets file degrades to empty rather than crashing the boot', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'listam-desk-secrets-'))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const path = join(dir, 'secrets.json')
    fs.writeFileSync(path, 'not-json{{{')

    const secretStore = createFileSecretStore({ fs, path })
    const prepared = await prepareDesktopSecrets(secretStore)
    assert.equal(prepared.mode, 'secure-store')
    assert.deepEqual(prepared.backendPayload.secrets ?? {}, {})
})
