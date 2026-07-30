import test from 'node:test'
import assert from 'node:assert/strict'

import { createInviteQrPayload } from '@listam/protocol'
import { createInviteQrMatrix } from '../src/qr-code.mjs'

test('invite QR matrix is square, deterministic and includes finder patterns', () => {
    const payload = createInviteQrPayload('mockShareInvitegroceriesxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', 'list')
    const first = createInviteQrMatrix(payload)
    const second = createInviteQrMatrix(payload)

    assert.deepEqual(first, second)
    assert.ok(first.moduleCount >= 21)
    assert.equal(first.modules.length, first.moduleCount)
    assert.ok(first.modules.every((row) => row.length === first.moduleCount))

    // The three QR finder patterns have dark outer corners.
    assert.equal(first.modules[0][0], true)
    assert.equal(first.modules[0][first.moduleCount - 1], true)
    assert.equal(first.modules[first.moduleCount - 1][0], true)
})

test('invite QR matrix preserves the typed project/list payload boundary', () => {
    const invite = 'ybndrfg8ejkmcpqxot1uwisza345h769'.repeat(4)
    const projectPayload = createInviteQrPayload(invite, 'project')
    const listPayload = createInviteQrPayload(invite, 'list')
    const project = createInviteQrMatrix(projectPayload)
    const list = createInviteQrMatrix(listPayload)

    assert.match(projectPayload, /^listam-invite:\/\/v1\/project\?invite=/)
    assert.match(listPayload, /^listam-invite:\/\/v1\/list\?invite=/)
    assert.notDeepEqual(project.modules, list.modules)
    assert.throws(() => createInviteQrMatrix(''), /non-empty string/)
})
