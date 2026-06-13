// Desktop leaf-bridge E2E smoke, run manually with:
//   node test/pear-smoke/run-smoke.mjs
//
// Spawns `pear run --dev` on the smoke app (which hosts the real
// backend-worker under Bare and drives the renderer's bridge frames), then
// dials the real Rust leaf-host (hardware/leaf-peer) into the bridge port.
// PASS requires: bridge starts via frame + control key issued + leaf connects
// (bridge-status push) + leaf mirrors at least one core with data + bridge
// stop via frame. Not part of `npm test` — needs the pear runtime and the
// built leaf-host binary.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const leafBin = join(here, '../../../hardware/leaf-peer/target/debug/leaf-host')
const PORT = 9981
const TIMEOUT_MS = 180_000

const leafDir = mkdtempSync(join(tmpdir(), 'listam-leaf-smoke-'))
const children = new Set()
const log = (...args) => console.log('[run-smoke]', ...args)

let pearLog = ''
let leafLog = ''
let leaf = null
let leafConnected = false
let stoppedStatus = null

function shutdown() {
    for (const child of children) {
        try {
            child.kill('SIGKILL')
        } catch {
            // already gone
        }
    }
    rmSync(leafDir, { recursive: true, force: true })
}

function fail(message) {
    log('FAIL:', message)
    log('--- pear output tail ---\n' + pearLog.slice(-3000))
    log('--- leaf output tail ---\n' + leafLog.slice(-2000))
    shutdown()
    process.exit(1)
}

const timeout = setTimeout(() => fail('timed out'), TIMEOUT_MS)

function startLeaf(controlKey) {
    log('control key issued, dialing leaf-host into the bridge')
    leaf = spawn(
        leafBin,
        [
            '--connect', `127.0.0.1:${PORT}`,
            '--key', controlKey, '--control',
            '--storage', leafDir,
            '--status-secs', '2',
        ],
        { env: { ...process.env, RUST_LOG: 'info' } },
    )
    children.add(leaf)
    leaf.stdout.on('data', (chunk) => { leafLog += chunk })
    leaf.stderr.on('data', (chunk) => { leafLog += chunk })
}

function finish() {
    clearTimeout(timeout)
    const mirrored = [...leafLog.matchAll(/status core=([0-9a-f]+) length=(\d+)/g)]
        .map((match) => ({ core: match[1], length: Number(match[2]) }))
    const withData = mirrored.filter((entry) => entry.length > 0)
    log('leaf mirrored cores:', JSON.stringify(mirrored.slice(-6)))

    if (!leafConnected) return fail('bridge never reported a leaf connection')
    if (withData.length === 0) return fail('leaf-host mirrored no core with data')
    if (!stoppedStatus || stoppedStatus.running !== false) return fail('bridge stop did not report a stopped status')

    log(`PASS — frame-driven bridge under Bare: leaf connected, ${withData.length} core(s) mirrored with data, clean stop`)
    shutdown()
    process.exit(0)
}

function handlePearLine(line) {
    const marker = line.match(/SMOKE (\S+)(?: (.*))?$/)
    if (!marker) return
    const [, kind, rest] = marker
    if (kind !== 'STATUS') log('smoke:', kind, (rest ?? '').slice(0, 80))
    if (kind === 'CONTROL-KEY') startLeaf(rest.trim())
    else if (kind === 'LEAF-CONNECTED') leafConnected = true
    else if (kind === 'STOPPED') {
        try {
            stoppedStatus = JSON.parse(rest)
        } catch {
            stoppedStatus = null
        }
        // Give the leaf a beat to log its view of the drop, then assert.
        setTimeout(finish, 1500)
    } else if (['TIMEOUT', 'BOOT-ERROR', 'START-FAILED', 'SMOKE-ERROR', 'PIPE-CLOSED-EARLY'].includes(kind)) {
        fail(`smoke app reported ${kind}: ${rest ?? ''}`)
    }
}

log(`pear run --dev ${here}`)
const pear = spawn('pear', ['run', '--dev', here], { env: process.env })
children.add(pear)

let lineBuffer = ''
pear.stdout.on('data', (chunk) => {
    pearLog += chunk
    lineBuffer += chunk
    let newline = lineBuffer.indexOf('\n')
    while (newline !== -1) {
        handlePearLine(lineBuffer.slice(0, newline))
        lineBuffer = lineBuffer.slice(newline + 1)
        newline = lineBuffer.indexOf('\n')
    }
})
pear.stderr.on('data', (chunk) => { pearLog += chunk })
pear.on('exit', (code) => {
    if (stoppedStatus === null) fail(`pear exited early (code ${code})`)
})
