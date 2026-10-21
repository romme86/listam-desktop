// Optional app path supports checking a freshly dumped release as well as source.
// PEAR_BIN selects the runtime; no user application storage is ever opened.
import { spawn } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RPC_ADD } from '@listam/protocol'
import { decodeProjectionSnapshot } from '@listam/client'

const here = dirname(fileURLToPath(import.meta.url))
const app = resolve(process.argv[2] || join(here, '../..'))
const macPear = join(homedir(), 'Library/Application Support/pear/bin/pear')
const pear = process.env.PEAR_BIN || (existsSync(macPear) ? macPear : 'pear')
// Pear bounds package discovery by cwd; macOS /var and /private/var must agree.
const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'listam-pear-boot-')))
let child
let output = ''
let timedOut = false
let timeout
let failure = null
let passed = false

try {
    writeFileSync(join(fixture, 'package.json'), JSON.stringify({
        name: 'listam-backend-boot-smoke', version: '0.0.0', private: true,
        type: 'module', main: 'boot.mjs', pear: { name: 'listam-backend-boot-smoke', type: 'terminal' },
    }))
    copyFileSync(join(here, 'boot.mjs'), join(fixture, 'boot.mjs'))
    cpSync(join(app, 'src'), join(fixture, 'src'), { recursive: true })
    symlinkSync(join(app, 'node_modules'), join(fixture, 'node_modules'), 'dir')
    child = spawn(pear, ['run', '--dev', '--tmp-store', fixture], {
        cwd: fixture, stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    })
    const pipe = child.stdio[3]
    const itemText = 'Desktop runtime startup smoke'
    let buffer = ''
    let projected = false
    let acknowledged = false
    const write = (frame) => pipe.write(`${JSON.stringify(frame)}\n`)
    pipe.on('error', (error) => { failure = error.message })
    pipe.on('data', (chunk) => {
        buffer += chunk
        let newline
        while ((newline = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newline)
            buffer = buffer.slice(newline + 1)
            if (!line.trim()) continue
            try {
                const frame = JSON.parse(line)
                if (frame.kind === 'ready') {
                    console.log('PEAR-BOOT READY')
                    write({ kind: 'req', id: 1, command: RPC_ADD, data: JSON.stringify({ text: itemText }) })
                } else if (frame.kind === 'boot-error' || frame.kind === 'worker-error') {
                    failure = frame.message
                    pipe.end()
                } else if (frame.kind === 'event') {
                    write({ kind: 'reply', id: frame.id, data: null })
                    if (frame.event?.type === 'add-from-backend' && frame.event.item?.text === itemText) projected = true
                    const snapshot = decodeProjectionSnapshot(frame.event?.payload)
                    if (snapshot?.source === 'verified-view' && snapshot.items.some((item) => item.text === itemText)) projected = true
                } else if (frame.kind === 'res' && frame.id === 1) {
                    if (JSON.parse(frame.data)?.ok !== true) throw new Error('Backend refused the test write')
                    acknowledged = true
                }
                if (projected && acknowledged && !passed) {
                    passed = true
                    console.log('PEAR-BOOT PASS backend ready; write acknowledged and projected')
                    pipe.end()
                }
            } catch (error) {
                failure = error.message
                pipe.end()
            }
        }
    })
    for (const stream of [child.stdout, child.stderr]) {
        stream.on('data', (chunk) => {
            output += chunk
            process.stdout.write(chunk)
        })
    }
    timeout = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 60_000)
    const code = await new Promise((resolve, reject) => {
        child.on('error', reject)
        child.on('close', resolve)
    })
    if (timedOut || code !== 0 || failure || !passed) {
        throw new Error(`Desktop runtime smoke failed (exit ${code}${timedOut ? ', timeout' : ''}): ${failure || output.slice(-2000)}`)
    }
} finally {
    clearTimeout(timeout)
    if (child && child.exitCode === null) child.kill('SIGKILL')
    rmSync(fixture, { recursive: true, force: true })
}
