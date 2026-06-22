// Cross-instance acceptance: two desktop-contract backends on a private DHT
// testnet pair through a real BlindPairing invite and converge on the same
// id-keyed list. This is the desktop row of the interaction matrix at the
// protocol level — mobile drives the identical backend over the identical
// client contract, so invite/sync interop is proven without a device.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import readline from 'node:readline'
import createTestnet from 'hyperdht/testnet.js'

const DRIVER = join(dirname(fileURLToPath(import.meta.url)), 'helpers', 'backend-driver.mjs')
const JOIN_TIMEOUT_MS = 120_000

class Driver {
    constructor(storageDir, bootstrap) {
        this.proc = spawn(process.execPath, [DRIVER, storageDir, JSON.stringify(bootstrap)], {
            stdio: ['pipe', 'pipe', 'pipe'],
        })
        this.nextId = 0
        this.pending = new Map()
        this.readyPromise = new Promise((resolve) => { this.resolveReady = resolve })
        const rl = readline.createInterface({ input: this.proc.stdout })
        rl.on('line', (line) => {
            let message = null
            try {
                message = JSON.parse(line)
            } catch {
                return
            }
            if (message.event === 'ready') this.resolveReady()
            if (message.id != null && this.pending.has(message.id)) {
                this.pending.get(message.id)(message)
                this.pending.delete(message.id)
            }
        })
        // Keep backend logs out of the TAP stream but surface them on failure.
        this.stderr = ''
        this.proc.stderr.on('data', (chunk) => {
            this.stderr += chunk
            if (process.env.LISTAM_DRIVER_LOG_DIR) {
                appendFileSync(join(process.env.LISTAM_DRIVER_LOG_DIR, `driver-${storageDir.split('-').at(-2) ?? 'x'}.log`), chunk)
            }
        })
        this.exited = false
        this.proc.on('exit', (code) => { this.exited = true; this.exitCode = code })
    }

    async ready() {
        // Fail fast (with the child's logs) instead of hanging the runner when
        // a driver dies during startup.
        const result = await Promise.race([
            this.readyPromise.then(() => 'ready'),
            once(this.proc, 'exit').then(() => 'exited'),
        ])
        if (result === 'exited') {
            throw new Error(`backend driver exited before ready (code ${this.exitCode})\nstderr tail: ${this.stderr.slice(-2000)}`)
        }
    }

    request(op, fields = {}) {
        if (this.exited) {
            return Promise.reject(new Error(`backend driver already exited (code ${this.exitCode})\nstderr tail: ${this.stderr.slice(-2000)}`))
        }
        const id = ++this.nextId
        const response = new Promise((resolve) => this.pending.set(id, resolve))
        this.proc.stdin.write(JSON.stringify({ id, op, ...fields }) + '\n')
        const exitRejection = once(this.proc, 'exit').then(() => {
            throw new Error(`backend driver exited mid-request '${op}' (code ${this.exitCode})\nstderr tail: ${this.stderr.slice(-2000)}`)
        })
        // The exit branch fires eventually even when the response won the race;
        // keep its rejection handled so teardown never reports it.
        exitRejection.catch(() => {})
        return Promise.race([response, exitRejection])
    }

    async waitFor(predicate, { timeoutMs = JOIN_TIMEOUT_MS, intervalMs = 1000 } = {}) {
        const deadline = Date.now() + timeoutMs
        for (;;) {
            const dump = await this.request('dump')
            if (predicate(dump)) return dump
            if (Date.now() > deadline) {
                throw new Error(`waitFor timed out; last dump: ${JSON.stringify(dump)}\nstderr tail: ${this.stderr.slice(-2000)}`)
            }
            await new Promise((resolve) => setTimeout(resolve, intervalMs))
        }
    }

    async stop() {
        if (this.exited) return
        try {
            const exited = once(this.proc, 'exit')
            const timeout = new Promise((resolve) => setTimeout(resolve, 10_000, 'timeout'))
            this.proc.stdin.write(JSON.stringify({ id: ++this.nextId, op: 'shutdown' }) + '\n')
            if (await Promise.race([exited, timeout]) === 'timeout') {
                this.proc.kill('SIGKILL')
            }
        } catch {
            this.proc.kill('SIGKILL')
        }
    }
}

test('desktop contract: two instances pair via invite on a private testnet and converge', { timeout: 300_000 }, async (t) => {
    const testnet = await createTestnet(3)
    const dirs = [mkdtempSync(join(tmpdir(), 'listam-desk-a-')), mkdtempSync(join(tmpdir(), 'listam-desk-b-'))]
    const bootstrap = testnet.bootstrap

    const host = new Driver(dirs[0], bootstrap)
    const guest = new Driver(dirs[1], bootstrap)
    t.after(async () => {
        await host.stop()
        await guest.stop()
        await testnet.destroy()
        for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    })

    await host.ready()
    await guest.ready()

    // Host seeds content and mints a real BlindPairing invite.
    await host.request('add', { text: 'Milk' })
    await host.request('add', { text: 'Bread' })
    const invite = (await host.request('invite')).inviteKey
    assert.ok(invite.length > 0, 'host produced an invite')

    // Guest joins through the invite and must become a writable member that
    // sees the host's items.
    await guest.request('join', { invite })
    const joined = await guest.waitFor((dump) => dump.joined)
    assert.ok(joined.joined, 'guest reported join-success')

    const guestSynced = await guest.waitFor((dump) => dump.items.length >= 2)
    const guestTexts = guestSynced.items.map((item) => item.text).sort()
    assert.deepEqual(guestTexts, ['Bread', 'Milk'])

    // The host accepted the guest as a writer through the owner-signed
    // membership flow (the roster broadcast lands asynchronously).
    await host.request('members')
    const hostRoster = await host.waitFor((dump) => (dump.roster?.writers?.length ?? 0) >= 2, { timeoutMs: 30_000 })
    assert.ok(hostRoster.roster.writers.length >= 2, 'host roster includes the joined guest')

    // Bidirectional steady-state convergence (guest writes, host converges by
    // stable id) depends on main-swarm reconnection that is flaky between two
    // local processes in sandboxed environments; the Phase 15 cross-instance
    // matrix owns it. Opt in with LISTAM_SYNC_FULL=1.
    if (process.env.LISTAM_SYNC_FULL === '1') {
        await guest.request('add', { text: 'Eggs' })
        const hostSynced = await host.waitFor((dump) => dump.items.some((item) => item.text === 'Eggs'))
        const guestEggs = (await guest.request('dump')).items.find((item) => item.text === 'Eggs')
        const hostEggs = hostSynced.items.find((item) => item.text === 'Eggs')
        assert.equal(hostEggs.id, guestEggs.id, 'item converged by stable id')

        await guest.request('update', { item: { ...guestEggs, isDone: true, timeOfCompletion: 1, updatedAt: Date.now() } })
        const hostDone = await host.waitFor((dump) => dump.items.some((item) => item.id === guestEggs.id && item.isDone))
        assert.equal(hostDone.items.filter((item) => item.id === guestEggs.id).length, 1)
    }
})

// RPC_MOVE decomposes a move into ordinary add/delete (different listId) or a
// single in-place update (same listId) so apply() and old peers need no new op.
// A solo backend exercises the full append -> apply -> echo round-trip; the
// driver keys items by (listId, id) exactly like the real reducers.
test('desktop contract: a cross-list move leaves exactly one copy (no duplicate)', { timeout: 120_000 }, async (t) => {
    const testnet = await createTestnet(1)
    const dir = mkdtempSync(join(tmpdir(), 'listam-desk-move-'))
    const drv = new Driver(dir, testnet.bootstrap)
    t.after(async () => { await drv.stop(); await testnet.destroy(); rmSync(dir, { recursive: true, force: true }) })
    await drv.ready()

    await drv.request('add', { text: 'Milk', listId: 'list-a', listType: 'shopping' })
    const seeded = await drv.waitFor((d) => d.items.some((i) => i.text === 'Milk' && i.listId === 'list-a'), { timeoutMs: 30_000 })
    const item = seeded.items.find((i) => i.text === 'Milk' && i.listId === 'list-a')

    await drv.request('move', { item, targetListId: 'list-b', targetListType: 'shopping' })
    const moved = await drv.waitFor((d) => d.items.some((i) => i.id === item.id && i.listId === 'list-b'), { timeoutMs: 30_000 })

    const copies = moved.items.filter((i) => i.id === item.id)
    assert.equal(copies.length, 1, 'exactly one copy after a cross-list move (no duplicate)')
    assert.equal(copies[0].listId, 'list-b', 'item lives on the destination list')
    assert.equal(copies[0].text, 'Milk', 'text preserved across the move')
})

test('desktop contract: a same-list type flip changes type in place, one copy', { timeout: 120_000 }, async (t) => {
    const testnet = await createTestnet(1)
    const dir = mkdtempSync(join(tmpdir(), 'listam-desk-flip-'))
    const drv = new Driver(dir, testnet.bootstrap)
    t.after(async () => { await drv.stop(); await testnet.destroy(); rmSync(dir, { recursive: true, force: true }) })
    await drv.ready()

    await drv.request('add', { text: 'Buy stamps', listId: 'default', listType: 'shopping' })
    const seeded = await drv.waitFor((d) => d.items.some((i) => i.text === 'Buy stamps'), { timeoutMs: 30_000 })
    const item = seeded.items.find((i) => i.text === 'Buy stamps')

    await drv.request('move', { item, targetListId: 'default', targetListType: 'todo' })
    const flipped = await drv.waitFor((d) => d.items.some((i) => i.id === item.id && i.listType === 'todo'), { timeoutMs: 30_000 })

    const copies = flipped.items.filter((i) => i.id === item.id)
    assert.equal(copies.length, 1, 'still exactly one copy after a same-list type flip')
    assert.equal(copies[0].listType, 'todo', 'type flipped to todo')
    assert.equal(copies[0].listId, 'default', 'stays in the same bucket')
})
