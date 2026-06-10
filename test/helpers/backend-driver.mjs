// Child-process backend driver for cross-instance tests. Each driver owns one
// @listam/backend on its own storage root and private-DHT bootstrap (the
// shared local test harness from the plan), and exposes scriptable primitives
// over stdin/stdout JSON lines: init, invite, join, add, update, delete,
// dump, members, shutdown.
//
// Run: node backend-driver.mjs <storageDir> <bootstrapJson>
import process from 'node:process'
import readline from 'node:readline'
import { startBackend, createNodePlatform } from '@listam/backend'
import { createBackendChannel } from '@listam/client'
import {
    RPC_ADD,
    RPC_UPDATE,
    RPC_DELETE,
    RPC_JOIN_KEY,
    RPC_CREATE_INVITE,
    RPC_REQUEST_SYNC,
    RPC_GET_MEMBERS,
} from '@listam/protocol'

const [storageDir, bootstrapJson] = process.argv.slice(2)
const bootstrap = bootstrapJson ? JSON.parse(bootstrapJson) : null

const state = {
    items: [],
    inviteKey: '',
    peerCount: 0,
    joined: false,
    roster: null,
}

function out(message) {
    process.stdout.write(JSON.stringify(message) + '\n')
}

const channel = createBackendChannel()
channel.client.onEvent((event) => {
    if (event.type === 'persist-secret') {
        // Durable secret storage is exercised elsewhere; ack as not-stored so
        // the backend keeps key material in memory for this throwaway run.
        event.reply(JSON.stringify({ stored: false, mode: 'driver-memory' }))
        return
    }
    if (event.type === 'sync-list') state.items = Array.isArray(event.items) ? event.items : []
    if (event.type === 'add-from-backend') state.items = [event.item, ...state.items.filter((i) => i.id !== event.item.id)]
    if (event.type === 'update-from-backend') state.items = state.items.map((i) => (i.id === event.item.id ? event.item : i))
    if (event.type === 'delete-from-backend') state.items = state.items.filter((i) => i.id !== event.item.id)
    if (event.type === 'invite-key' && event.key) state.inviteKey = event.key
    if (event.type === 'message') {
        const payload = event.payload
        if (payload?.type === 'peer-count') state.peerCount = payload.count ?? 0
        if (payload?.type === 'join-success') state.joined = true
        if (payload?.type === 'join-error') out({ event: 'join-error', message: payload.message })
        if (payload?.type === 'membership-roster') state.roster = payload.roster ?? null
    }
})

const platform = createNodePlatform({ argv: [storageDir, '', '', ''] })
platform.createRpc = channel.platform.createRpc
platform.bootstrap = bootstrap

const backend = await startBackend(platform)
out({ event: 'ready' })

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', async (line) => {
    let request = null
    try {
        request = JSON.parse(line)
    } catch {
        out({ event: 'error', message: 'bad request json' })
        return
    }

    const { id, op } = request
    try {
        switch (op) {
            case 'invite':
                await channel.client.send(RPC_CREATE_INVITE)
                out({ id, ok: true, inviteKey: state.inviteKey })
                break
            case 'join':
                await channel.client.send(RPC_JOIN_KEY, { key: request.invite })
                out({ id, ok: true })
                break
            case 'add':
                await channel.client.send(RPC_ADD, { text: request.text })
                out({ id, ok: true })
                break
            case 'update':
                await channel.client.send(RPC_UPDATE, { item: request.item })
                out({ id, ok: true })
                break
            case 'delete':
                await channel.client.send(RPC_DELETE, { item: request.item })
                out({ id, ok: true })
                break
            case 'sync':
                await channel.client.send(RPC_REQUEST_SYNC)
                out({ id, ok: true })
                break
            case 'members':
                await channel.client.send(RPC_GET_MEMBERS)
                out({ id, ok: true, roster: state.roster })
                break
            case 'dump':
                out({ id, ok: true, items: state.items, peerCount: state.peerCount, joined: state.joined, inviteKey: state.inviteKey, roster: state.roster })
                break
            case 'shutdown':
                out({ id, ok: true })
                await backend.shutdown()
                process.exit(0)
                break
            default:
                out({ id, ok: false, message: `unknown op ${op}` })
        }
    } catch (error) {
        out({ id, ok: false, message: error?.message ?? String(error) })
    }
})
