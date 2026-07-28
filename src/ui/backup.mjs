// Encrypted backup / restore, plus the automatic pre-join and scheduled rolling
// backups. Extracted from ui.mjs as Slice 3 of the UI decomposition.
//
// Unlike `send`, these need the worker's REPLY (the encrypted file, the import
// outcome), so they call client.send directly and parse the JSON themselves.
//
// HOW THIS DIFFERS FROM ./servers.mjs, and why it matters: the Servers section
// owned its cache outright because every reference to it was inside that block.
// The backup state is NOT like that — `ui.backups`, `ui.backupPasswordSet` and
// `ui.backupSchedule` are read by the settings/backup dialogs, and
// backupPasswordSet is also WRITTEN by the join flow, which refuses to replace
// the local base until a backup password exists. So this module takes the shared
// `ui` object instead of pretending to an encapsulation that isn't there.
// Measure before assuming a slice can own its state.
import {
    RPC_EXPORT_DATA,
    RPC_EXPORT_SEED,
    RPC_IMPORT,
    RPC_LIST_BACKUPS,
    RPC_RESTORE_BACKUP,
    RPC_SET_BACKUP_PASSWORD,
    RPC_SET_BACKUP_SCHEDULE,
} from '@listam/protocol'
import { h } from '../dom.mjs'

/**
 * @param {object} deps
 * @param {object} deps.client        backend RPC client (send returns the raw reply)
 * @param {object} deps.ui            shared renderer state; owns backups/backupPasswordSet/backupSchedule
 * @param {object} deps.store         desktop store (pushNotice only)
 * @param {object} deps.locale        i18n holder ({ i18n })
 * @param {() => void} deps.renderAll
 * @param {(spec: object) => void} deps.openDialog
 * @param {() => void} deps.closeDialog
 * @param {() => Date} [deps.clock]   injected for the filename stamp; defaults to the wall clock
 */
export function createBackupOps ({
    client,
    ui,
    store,
    locale,
    renderAll,
    openDialog,
    closeDialog,
    clock = () => new Date(),
}) {
    /** Send a command and parse its JSON reply; a malformed or empty reply is null. */
    async function backupRequest (command, payload) {
        const raw = await client.send(command, payload)
        try { return raw ? JSON.parse(raw) : null } catch { return null }
    }

    // Every backend refusal reason the user can actually act on gets its own
    // message; anything else falls back to the generic one rather than leaking
    // a wire string into the UI.
    function backupErrorMessage (reason) {
        const t = locale.i18n.t.bind(locale.i18n)
        switch (reason) {
            case 'bad-password': return t('backup.error.badPassword')
            case 'invalid-file': return t('backup.error.invalidFile')
            case 'seed-incomplete': return t('backup.error.seedIncomplete')
            case 'not-writable': return t('backup.error.notWritable')
            case 'sync-stalled': return t('backup.error.syncStalled')
            default: return t('backup.error.generic')
        }
    }

    function backupFilename (kind) {
        const stamp = clock().toISOString().slice(0, 10)
        return kind === 'seed' ? `listam-seed-${stamp}.listamseed` : `listam-backup-${stamp}.listam`
    }

    function downloadTextFile (filename, text) {
        const url = URL.createObjectURL(new Blob([text], { type: 'application/octet-stream' }))
        const anchor = h('a', { href: url, download: filename })
        document.body.append(anchor)
        anchor.click()
        anchor.remove()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
    }

    function pickBackupFile () {
        return new Promise((resolve) => {
            const input = h('input', {
                type: 'file',
                accept: '.listam,.listamseed,application/json,application/octet-stream',
                style: 'display:none',
            })
            input.addEventListener('change', () => {
                const file = input.files && input.files[0]
                if (!file) { input.remove(); resolve(null); return }
                const reader = new FileReader()
                reader.onload = () => { input.remove(); resolve(String(reader.result || '')) }
                reader.onerror = () => { input.remove(); resolve(null) }
                reader.readAsText(file)
            }, { once: true })
            document.body.append(input)
            input.click()
        })
    }

    async function startBackupImport () {
        const fileText = await pickBackupFile()
        if (fileText == null) return
        let fileKind = null
        try { fileKind = JSON.parse(fileText)?.kind } catch { /* shown as invalid on submit */ }
        openDialog({ kind: 'backup', mode: 'import', fileText, fileKind })
    }

    async function runBackupExport (mode, password) {
        const t = locale.i18n.t.bind(locale.i18n)
        closeDialog()
        store.pushNotice(t('backup.working'), 'info')
        const res = await backupRequest(mode === 'export-seed' ? RPC_EXPORT_SEED : RPC_EXPORT_DATA, { password })
        if (res?.ok && res.file) {
            downloadTextFile(backupFilename(res.kind), res.file)
            store.pushNotice(t('backup.exported'), 'success')
        } else {
            store.pushNotice(backupErrorMessage(res?.reason), 'error')
        }
    }

    async function runBackupImport (fileText, password) {
        const t = locale.i18n.t.bind(locale.i18n)
        closeDialog()
        store.pushNotice(t('backup.working'), 'info')
        const res = await backupRequest(RPC_IMPORT, { password, file: fileText })
        if (!res?.ok) { store.pushNotice(backupErrorMessage(res?.reason), 'error'); return }
        if (res.kind === 'seed') { store.pushNotice(t('backup.seedRestored'), 'success'); return }
        // Defensive: an ok reply that still names a refusal reason. Kept as-is
        // from the original — an extraction is not the place to decide whether
        // the backend can produce it.
        if (res.reason === 'not-writable') { store.pushNotice(t('backup.error.notWritable'), 'error'); return }
        store.pushNotice(t('backup.imported', { count: res.applied?.items ?? 0 }), 'success')
        if (res.applied?.boardConfigSkipped) store.pushNotice(t('backup.boardConfigSkipped'), 'info')
    }

    // --- automatic pre-join backups ---------------------------------------
    async function loadAutoBackups () {
        const res = await backupRequest(RPC_LIST_BACKUPS)
        ui.backups = (res && Array.isArray(res.backups)) ? res.backups : []
        ui.backupPasswordSet = !!(res && res.passwordSet)
        // The rolling scheduled-backup tiers (15m / 1d / 1w) ride along on the
        // same reply; null means the backend didn't report one yet.
        ui.backupSchedule = (res && res.schedule) ? res.schedule : null
        renderAll()
    }

    async function runSetBackupSchedule (enabled) {
        const res = await backupRequest(RPC_SET_BACKUP_SCHEDULE, { enabled })
        if (!res?.ok) { store.pushNotice(backupErrorMessage(res?.reason), 'error'); return }
        // Reuse the returned schedule when present; otherwise re-fetch so the
        // tier rows and toggle reflect the persisted on/off choice.
        if (res.schedule) { ui.backupSchedule = res.schedule; renderAll() }
        else loadAutoBackups()
    }

    async function runSetBackupPassword (current, next) {
        const t = locale.i18n.t.bind(locale.i18n)
        closeDialog()
        const res = await backupRequest(RPC_SET_BACKUP_PASSWORD, { current, next })
        if (!res?.ok) { store.pushNotice(backupErrorMessage(res?.reason), 'error'); return }
        store.pushNotice(t('backup.auto.passwordSaved'), 'success')
        loadAutoBackups()
    }

    async function runRestoreAutoBackup (file, password) {
        const t = locale.i18n.t.bind(locale.i18n)
        closeDialog()
        store.pushNotice(t('backup.working'), 'info')
        const res = await backupRequest(RPC_RESTORE_BACKUP, { file, password })
        if (!res?.ok) { store.pushNotice(backupErrorMessage(res?.reason), 'error'); return }
        store.pushNotice(t('backup.auto.restored', { count: res.applied?.items ?? 0 }), 'success')
        if (res.applied?.boardConfigSkipped) store.pushNotice(t('backup.boardConfigSkipped'), 'info')
        loadAutoBackups()
    }

    return {
        backupRequest,
        startBackupImport,
        runBackupExport,
        runBackupImport,
        loadAutoBackups,
        runSetBackupSchedule,
        runSetBackupPassword,
        runRestoreAutoBackup,
        // Not reached from the renderer; exposed for tests.
        backupErrorMessage,
        backupFilename,
    }
}
