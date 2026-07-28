// Backup reply handling, previously sealed inside ui.mjs's mountApp closure.
//
// This surface is worth testing beyond the usual refactor argument: it is the
// path that decides whether a user is told their data was saved. A refusal
// reported as a success, or a success reported with the wrong count, is a
// data-confidence bug even when no bytes are lost.
//
// Only the non-DOM half runs here. downloadTextFile/pickBackupFile touch Blob,
// URL.createObjectURL and FileReader; they are exercised by the real-app pass.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
    RPC_EXPORT_DATA,
    RPC_EXPORT_SEED,
    RPC_IMPORT,
    RPC_LIST_BACKUPS,
    RPC_RESTORE_BACKUP,
    RPC_SET_BACKUP_PASSWORD,
    RPC_SET_BACKUP_SCHEDULE,
} from '@listam/protocol'
import { createBackupOps } from '../src/ui/backup.mjs'

function harness (replies = {}) {
    const sent = []
    const notices = []
    const ui = {}
    let closed = 0
    const ops = createBackupOps({
        client: {
            send: async (command, payload) => {
                sent.push({ command, payload })
                const reply = replies[command]
                const value = typeof reply === 'function' ? reply() : reply
                return value === undefined ? null : value
            },
        },
        ui,
        store: { pushNotice: (message, kind) => notices.push({ message, kind }) },
        // The catalog is the identity function, so a notice's `message` IS the
        // key — asserting on keys keeps these tests independent of copy edits.
        locale: { i18n: { t: (key) => key } },
        renderAll: () => {},
        openDialog: () => {},
        closeDialog: () => { closed += 1 },
        clock: () => new Date('2026-07-28T22:13:00Z'),
    })
    return { ops, sent, notices, ui, closed: () => closed }
}

const kinds = (notices) => notices.map((n) => n.kind)
const keys = (notices) => notices.map((n) => n.message)

// runSetBackupSchedule / runSetBackupPassword / runRestoreAutoBackup call
// loadAutoBackups() WITHOUT awaiting it — the user-facing notice is pushed
// immediately and the list refreshes a tick later (loadAutoBackups renders
// itself). That is the shipped behaviour, so a test asserting on the refreshed
// state has to let the fire-and-forget chain settle first.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

test('backupRequest parses a JSON reply and survives junk without throwing', async () => {
    const { ops } = harness({ [RPC_LIST_BACKUPS]: '{"ok":true,"backups":[]}' })
    assert.deepEqual(await ops.backupRequest(RPC_LIST_BACKUPS), { ok: true, backups: [] })

    const bad = harness({ [RPC_LIST_BACKUPS]: 'not json at all' })
    assert.equal(await bad.ops.backupRequest(RPC_LIST_BACKUPS), null,
        'a malformed reply must be null, not an exception escaping into a click handler')

    const empty = harness({ [RPC_LIST_BACKUPS]: '' })
    assert.equal(await empty.ops.backupRequest(RPC_LIST_BACKUPS), null)
})

test('every actionable refusal reason gets its own message; anything else is generic', () => {
    const { ops } = harness()
    assert.equal(ops.backupErrorMessage('bad-password'), 'backup.error.badPassword')
    assert.equal(ops.backupErrorMessage('invalid-file'), 'backup.error.invalidFile')
    assert.equal(ops.backupErrorMessage('seed-incomplete'), 'backup.error.seedIncomplete')
    assert.equal(ops.backupErrorMessage('not-writable'), 'backup.error.notWritable')
    assert.equal(ops.backupErrorMessage('sync-stalled'), 'backup.error.syncStalled')
    // An unknown wire reason must NOT be shown raw.
    assert.equal(ops.backupErrorMessage('some-new-backend-reason'), 'backup.error.generic')
    assert.equal(ops.backupErrorMessage(undefined), 'backup.error.generic')
})

test('the filename carries the date and distinguishes a seed from a full backup', () => {
    const { ops } = harness()
    assert.equal(ops.backupFilename('seed'), 'listam-seed-2026-07-28.listamseed')
    assert.equal(ops.backupFilename('data'), 'listam-backup-2026-07-28.listam')
    assert.equal(ops.backupFilename(undefined), 'listam-backup-2026-07-28.listam')
})

test('export picks the seed command only for export-seed', async () => {
    const seed = harness({ [RPC_EXPORT_SEED]: '{"ok":false,"reason":"seed-incomplete"}' })
    await seed.ops.runBackupExport('export-seed', 'pw')
    assert.equal(seed.sent[0].command, RPC_EXPORT_SEED)

    const data = harness({ [RPC_EXPORT_DATA]: '{"ok":false,"reason":"bad-password"}' })
    await data.ops.runBackupExport('export-data', 'pw')
    assert.equal(data.sent[0].command, RPC_EXPORT_DATA)
})

test('an export that returns ok but NO file is an error, not a silent success', async () => {
    // The failure that would be worst here: telling the user it worked when
    // nothing was produced to download.
    const { ops, notices } = harness({ [RPC_EXPORT_DATA]: '{"ok":true}' })
    await ops.runBackupExport('export-data', 'pw')
    assert.ok(!kinds(notices).includes('success'), 'no success notice without a file')
    assert.ok(keys(notices).includes('backup.error.generic'))
})

test('a refused import reports the reason and stops', async () => {
    const { ops, notices, closed } = harness({ [RPC_IMPORT]: '{"ok":false,"reason":"bad-password"}' })
    await ops.runBackupImport('{}', 'wrong')
    assert.equal(closed(), 1, 'the dialog closes before the round-trip either way')
    assert.deepEqual(keys(notices), ['backup.working', 'backup.error.badPassword'])
    assert.equal(kinds(notices).includes('success'), false)
})

test('a seed restore reports the seed message, not an item count', async () => {
    const { ops, notices } = harness({ [RPC_IMPORT]: '{"ok":true,"kind":"seed"}' })
    await ops.runBackupImport('{}', 'pw')
    assert.ok(keys(notices).includes('backup.seedRestored'))
    assert.equal(keys(notices).includes('backup.imported'), false)
})

test('an import reports the applied count and flags a skipped board config', async () => {
    const { ops, notices } = harness({
        [RPC_IMPORT]: '{"ok":true,"applied":{"items":42,"boardConfigSkipped":true}}',
    })
    await ops.runBackupImport('{}', 'pw')
    const success = notices.find((n) => n.kind === 'success')
    assert.equal(success.message, 'backup.imported')
    // The skip is surfaced separately: the import succeeded, but the
    // owner-signed board config was deliberately not applied.
    assert.ok(keys(notices).includes('backup.boardConfigSkipped'))
})

test('an import with no applied block reports zero rather than undefined', async () => {
    const { ops, notices } = harness({ [RPC_IMPORT]: '{"ok":true}' })
    await ops.runBackupImport('{}', 'pw')
    assert.ok(keys(notices).includes('backup.imported'))
})

test('loadAutoBackups normalizes every field, including a junk reply', async () => {
    const good = harness({
        [RPC_LIST_BACKUPS]: '{"backups":[{"file":"a"}],"passwordSet":true,"schedule":{"enabled":true}}',
    })
    await good.ops.loadAutoBackups()
    assert.deepEqual(good.ui.backups, [{ file: 'a' }])
    assert.equal(good.ui.backupPasswordSet, true)
    assert.deepEqual(good.ui.backupSchedule, { enabled: true })

    // A null/garbage reply must leave usable state, not undefined — the dialog
    // renders straight off these fields.
    const bad = harness({ [RPC_LIST_BACKUPS]: 'garbage' })
    await bad.ops.loadAutoBackups()
    assert.deepEqual(bad.ui.backups, [], 'an array, so .length and .map are safe')
    assert.equal(bad.ui.backupPasswordSet, false)
    assert.equal(bad.ui.backupSchedule, null)

    // A non-array `backups` must not reach the dialog either.
    const weird = harness({ [RPC_LIST_BACKUPS]: '{"backups":"nope"}' })
    await weird.ops.loadAutoBackups()
    assert.deepEqual(weird.ui.backups, [])
})

test('setting the schedule uses the returned value, else re-fetches', async () => {
    const inline = harness({ [RPC_SET_BACKUP_SCHEDULE]: '{"ok":true,"schedule":{"enabled":true}}' })
    await inline.ops.runSetBackupSchedule(true)
    assert.deepEqual(inline.ui.backupSchedule, { enabled: true })
    assert.equal(inline.sent.length, 1, 'no re-fetch needed when the reply carries the schedule')

    const refetch = harness({
        [RPC_SET_BACKUP_SCHEDULE]: '{"ok":true}',
        [RPC_LIST_BACKUPS]: '{"schedule":{"enabled":false}}',
    })
    await refetch.ops.runSetBackupSchedule(false)
    await settle()
    assert.deepEqual(refetch.sent.map((s) => s.command), [RPC_SET_BACKUP_SCHEDULE, RPC_LIST_BACKUPS])
    assert.deepEqual(refetch.ui.backupSchedule, { enabled: false })
})

test('a refused schedule change does not touch the cached schedule', async () => {
    const { ops, ui, notices, sent } = harness({ [RPC_SET_BACKUP_SCHEDULE]: '{"ok":false,"reason":"not-writable"}' })
    ui.backupSchedule = { enabled: true }
    await ops.runSetBackupSchedule(false)
    await settle()
    assert.deepEqual(ui.backupSchedule, { enabled: true }, 'a refusal must not look like it applied')
    assert.equal(sent.length, 1, 'and must not trigger a re-fetch')
    assert.ok(keys(notices).includes('backup.error.notWritable'))
})

test('setting a password re-reads state on success and does not on refusal', async () => {
    const ok = harness({
        [RPC_SET_BACKUP_PASSWORD]: '{"ok":true}',
        [RPC_LIST_BACKUPS]: '{"passwordSet":true}',
    })
    await ok.ops.runSetBackupPassword('old', 'new')
    await settle()
    assert.equal(ok.ui.backupPasswordSet, true, 'the dialog gates on this, so it must be refreshed')
    assert.ok(keys(ok.notices).includes('backup.auto.passwordSaved'))

    const bad = harness({ [RPC_SET_BACKUP_PASSWORD]: '{"ok":false,"reason":"bad-password"}' })
    await bad.ops.runSetBackupPassword('wrong', 'new')
    await settle()
    assert.deepEqual(bad.sent.map((s) => s.command), [RPC_SET_BACKUP_PASSWORD])
    assert.equal(bad.ui.backupPasswordSet, undefined)
})

test('restoring an auto-backup refreshes the list only after a success', async () => {
    const ok = harness({
        [RPC_RESTORE_BACKUP]: '{"ok":true,"applied":{"items":7}}',
        [RPC_LIST_BACKUPS]: '{"backups":[]}',
    })
    await ok.ops.runRestoreAutoBackup('file', 'pw')
    await settle()
    assert.deepEqual(ok.sent.map((s) => s.command), [RPC_RESTORE_BACKUP, RPC_LIST_BACKUPS])
    assert.ok(keys(ok.notices).includes('backup.auto.restored'))

    const bad = harness({ [RPC_RESTORE_BACKUP]: '{"ok":false,"reason":"invalid-file"}' })
    await bad.ops.runRestoreAutoBackup('file', 'pw')
    await settle()
    assert.deepEqual(bad.sent.map((s) => s.command), [RPC_RESTORE_BACKUP])
    assert.ok(keys(bad.notices).includes('backup.error.invalidFile'))
})
