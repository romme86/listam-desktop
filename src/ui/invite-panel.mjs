import { h } from '../dom.mjs'
import { createInviteQr } from '../qr-code.mjs'
import { createInviteQrPayload } from '@listam/protocol'

export function createInvitePanel(invites = []) {
    return { count: 1, ttlMs: 600000, invites, busy: false, error: null, qrKey: invites.length === 1 ? invites[0].key : null }
}

export function inviteGenerationErrorKey(reason) {
    return ({ 'not-owner': 'invite.share.ownerOnly', 'not-ready': 'invite.batch.notReady',
        'invite-limit': 'invite.batch.limit', 'invalid-invite-options': 'invite.batch.invalidOptions' })[reason] || 'invite.batch.failed'
}

export function renderInvitePanel({ model, scope, t, now, generate, copy, refresh }) {
    const durations = [5, 10, 30, 60, 1440]
    const select = (id, label, values, current, change) => h('label', { class: 'invite-field', for: id },
        h('span', { class: 'label-sm' }, label),
        h('select', { id, class: 'input', disabled: model.busy ? '' : null, onchange: (event) => change(Number(event.target.value)) },
            ...values.map(([value, text]) => h('option', { value, selected: value === current ? '' : null }, text))),
    )
    return h('section', { class: 'invite-panel', 'aria-label': t('invite.batch.generate') },
        h('p', { class: 'body-md' }, t('invite.batch.help')),
        h('div', { class: 'invite-controls' },
            select('invite-count', t('invite.batch.count'), Array.from({ length: 8 }, (_, i) => [i + 1, String(i + 1)]), model.count, (v) => { model.count = v }),
            select('invite-validity', t('invite.batch.validity'), durations.map((minutes) => [minutes * 60000,
                t(minutes < 60 ? 'invite.batch.minutes' : 'invite.batch.hours', { count: minutes < 60 ? minutes : minutes / 60 })]), model.ttlMs, (v) => { model.ttlMs = v }),
            h('button', { id: 'invite-generate', class: 'btn btn-primary', disabled: model.busy ? '' : null, onclick: generate }, t(model.busy ? 'invite.batch.generating' : 'invite.batch.generate')),
        ),
        model.error ? h('p', { class: 'invite-panel-error body-md', role: 'alert' }, t(inviteGenerationErrorKey(model.error.reason), { available: model.error.available ?? 0 })) : null,
        h('p', { class: 'invite-panel-hint body-md' }, t('invite.batch.keepOpen')),
        h('div', { class: 'invite-code-list' }, ...model.invites.map((invite, index) => {
            const expired = Number.isFinite(invite.expiresAt) && now >= invite.expiresAt
            const showQr = !expired && model.qrKey === invite.key
            return h('article', { class: 'invite-code-row', 'aria-label': t('invite.batch.code', { number: index + 1 }) },
                h('div', { class: 'invite-code-heading' },
                    h('h3', { class: 'label-md' }, t('invite.batch.code', { number: index + 1 })),
                    h('span', { class: 'label-sm' }, expired ? t('invite.expired') : Number.isFinite(invite.expiresAt)
                        ? t('invite.batch.expiresAt', { time: new Date(invite.expiresAt).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) }) : t('invite.singleUse')),
                ),
                !expired ? h('div', { class: 'invite-code' }, invite.key) : null,
                !expired ? h('div', { class: 'invite-actions' },
                    h('button', { id: `invite-copy-${index}`, class: 'btn btn-secondary', onclick: () => copy(invite.key) }, t('invite.batch.copy', { number: index + 1 })),
                    h('button', { id: `invite-qr-${index}`, class: 'btn btn-secondary', 'aria-expanded': String(showQr), onclick: () => { model.qrKey = showQr ? null : invite.key; refresh() } }, t(showQr ? 'invite.batch.hideQr' : 'invite.batch.showQr')),
                ) : null,
                showQr ? createInviteQr(createInviteQrPayload(invite.key, scope), t(scope === 'list' ? 'shareList.title' : 'share.project.dialogTitle')) : null,
            )
        })),
    )
}
