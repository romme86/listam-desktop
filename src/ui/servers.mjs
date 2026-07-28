// The Servers section: remote headless peers operated over owner-control.
//
// Extracted from ui.mjs as Slice 2 of the UI decomposition. It was chosen
// because its per-mount state is genuinely encapsulated — every reference to
// `ui.servers` in the whole renderer was inside this block — so the factory can
// own that state outright instead of reaching into a shared object.
//
// It renders as a section INSIDE the Peers & Devices pane, not a top-level nav
// view. Only four symbols are reached from outside: buildServersSection (the
// pane), shutdownServer (the confirm dialog), and refreshServer /
// refreshAllServers (the 20s poll).
//
// A note on why this pane earns real-app verification rather than just a DOM
// diff: it spent months rendering its "unavailable" branch on every build
// because owner-control imported bare modules into the renderer, and every
// offline gate stayed green throughout. The mock backend has no owner-control,
// so `ownerControl` is null there and the fallback branch is the ONLY thing a
// mock snapshot can ever exercise.
import { h } from '../dom.mjs'
import { formatAgo, formatUptime } from '@listam/domain/peer-display'

function formatBytes (n) {
    const bytes = Number(n) || 0
    if (bytes < 1024) return `${bytes} B`
    const units = ['KB', 'MB', 'GB', 'TB']
    let value = bytes / 1024
    let unit = 0
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
    return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

/**
 * @param {object} deps
 * @param {object|null} deps.ownerControl  owner-control bridge, or null when unavailable
 * @param {object} deps.store              desktop store (pushNotice only)
 * @param {object} deps.locale             i18n holder ({ i18n })
 * @param {() => number} deps.now          injected clock
 * @param {() => void} deps.renderAll      re-render the app
 * @param {(spec: object) => void} deps.openDialog
 * @param {() => void} deps.closeDialog
 * @param {(text: string, successKey: string) => Promise<void>} deps.copyText
 * @param {Record<string, object>} [deps.servers]  per-server state; injectable for tests
 */
export function createServersSection ({
    ownerControl,
    store,
    locale,
    now,
    renderAll,
    openDialog,
    closeDialog,
    copyText,
    servers: serverState = {},
}) {
    // Per-paired-server monitoring state, keyed by serverPublicKeyHex:
    // { status, fetchedAt, error, busy, invite }. `undefined` means never
    // fetched, which is what triggers the first auto-query.
    const servers = serverState

    function serverCan (key, capability) {
        const server = ownerControl?.listServers().find((entry) => entry.serverPublicKeyHex === key)
        return (server?.capabilities ?? []).includes(capability)
    }

    // Query one server's status; updates servers[key] then re-renders. The busy
    // flag both shows a spinner-ish state and guards against overlapping polls
    // (the auto-poll and a manual click can race).
    async function refreshServer (key, { silent = false } = {}) {
        if (!ownerControl) return
        const prev = servers[key] ?? {}
        if (prev.busy) return
        // A server that never granted status:read would reject every status
        // request, so skip it (the card shows a no-access state instead).
        if (!serverCan(key, 'status:read')) return
        servers[key] = { ...prev, busy: true }
        if (!silent) renderAll()
        // Re-read the live entry at write time rather than reusing the pre-await
        // `prev`: a poll resolving must not clobber an invite (or any field) set
        // by mintServerInvite/etc. while the status round-trip was in flight.
        // This handler owns only busy/status/error/fetchedAt. On failure we drop
        // `status` so the card shows a clean offline state, not stale stats.
        try {
            const reply = await ownerControl.request(key, 'status')
            const cur = servers[key] ?? {}
            servers[key] = reply?.ok
                ? { ...cur, status: reply.status, error: null, busy: false, fetchedAt: now() }
                : { ...cur, status: undefined, busy: false, error: reply?.reason ?? 'error', fetchedAt: now() }
        } catch (error) {
            const cur = servers[key] ?? {}
            servers[key] = { ...cur, status: undefined, busy: false, error: error?.message ?? 'error', fetchedAt: now() }
        }
        renderAll()
    }

    function refreshAllServers (opts) {
        if (!ownerControl) return
        // refreshServer self-skips servers without status:read.
        for (const server of ownerControl.listServers()) refreshServer(server.serverPublicKeyHex, opts)
    }

    async function mintServerInvite (key) {
        const t = locale.i18n.t.bind(locale.i18n)
        try {
            const reply = await ownerControl.request(key, 'invite')
            if (reply?.ok && reply.inviteKey) {
                servers[key] = { ...(servers[key] ?? {}), invite: reply.inviteKey }
                store.pushNotice(t('desktop.servers.inviteMinted'), 'success')
            } else {
                store.pushNotice(`${t('desktop.servers.inviteFailed')} (${reply?.reason ?? 'error'})`, 'error')
            }
        } catch (error) {
            store.pushNotice(`${t('desktop.servers.inviteFailed')} (${error?.message ?? 'error'})`, 'error')
        }
        renderAll()
    }

    async function exportServer (key) {
        const t = locale.i18n.t.bind(locale.i18n)
        try {
            const reply = await ownerControl.request(key, 'export')
            if (reply?.ok && reply.export) {
                await navigator.clipboard.writeText(JSON.stringify(reply.export, null, 2))
                const count = Array.isArray(reply.export.items) ? reply.export.items.length : 0
                store.pushNotice(t('desktop.servers.exported', { count }), 'success')
            } else {
                store.pushNotice(`${t('desktop.servers.exportFailed')} (${reply?.reason ?? 'error'})`, 'error')
            }
        } catch (error) {
            store.pushNotice(`${t('desktop.servers.exportFailed')} (${error?.message ?? 'error'})`, 'error')
        }
    }

    async function shutdownServer (key) {
        const t = locale.i18n.t.bind(locale.i18n)
        closeDialog()
        try {
            const reply = await ownerControl.request(key, 'shutdown')
            if (reply?.ok) store.pushNotice(t('desktop.servers.shutdownOk'), 'success')
            else store.pushNotice(`${t('desktop.servers.shutdownFailed')} (${reply?.reason ?? 'error'})`, 'error')
        } catch (error) {
            store.pushNotice(`${t('desktop.servers.shutdownFailed')} (${error?.message ?? 'error'})`, 'error')
        }
        // The peer is going away; drop its cached status (so it reads offline)
        // and any minted invite (a single-use code is useless once it shuts down).
        servers[key] = { ...(servers[key] ?? {}), status: undefined, error: null, invite: undefined }
        renderAll()
    }

    function renderServerStats (status, t) {
        const rows = []
        const add = (label, value) => rows.push(h('div', { class: 'kv-row' },
            h('span', { class: 'label-sm', style: 'color: var(--secondary);' }, label),
            h('span', { class: 'body-md' }, value),
        ))
        add(t('desktop.servers.field.role'), status.role === 'blind-storage' ? t('members.role.blind') : String(status.role ?? '—'))
        add(t('desktop.servers.field.joined'), status.joined ? t('desktop.servers.yes') : t('desktop.servers.no'))
        add(t('desktop.servers.field.peers'), String(status.peerCount ?? 0))
        add(t('desktop.servers.field.items'), String(status.itemCount ?? 0))
        if (status.quota) {
            add(t('desktop.servers.field.storage'),
                `${formatBytes(status.quota.usedBytes)} / ${formatBytes(status.quota.maxBytes)}${status.quota.exceeded ? ' ⚠' : ''}`)
        }
        add(t('desktop.servers.field.invite'), status.inviteActive ? t('desktop.servers.yes') : t('desktop.servers.no'))
        const leaf = status.leafBridge
        add(t('desktop.servers.field.leaf'), leaf ? (leaf.hubAddr || `:${leaf.port}`) : t('desktop.servers.leafOff'))
        if (leaf?.audioAddr) add(t('desktop.servers.field.voice'), leaf.audioAddr)
        if (status.startedAt) add(t('desktop.servers.field.uptime'), formatUptime(now() - status.startedAt))
        if (status.updatedAt) add(t('desktop.servers.field.updated'), t('desktop.servers.updatedAgo', { ago: formatAgo(now() - status.updatedAt) }))
        return h('div', { class: 'kv-rows' }, ...rows)
    }

    function renderServerCard (server, t) {
        const key = server.serverPublicKeyHex
        const entry = servers[key] ?? {}
        const status = entry.status
        const online = !!status && !entry.error
        const caps = server.capabilities ?? []
        const can = (cap) => caps.includes(cap)
        const canRead = can('status:read')
        const stateLabel = !canRead
            ? t('desktop.servers.noStatusAccess')
            : entry.busy
                ? t('desktop.servers.checking')
                : (online ? t('desktop.servers.online') : t('desktop.servers.offline'))
        return h('div', { class: 'server-card' },
            h('div', { class: 'server-card-head' },
                h('span', { class: `dot${!entry.busy && online ? ' live' : ''}` }),
                h('span', { class: 'body-md server-name' }, server.name),
                h('span', { class: 'role-chip' }, key.slice(0, 8)),
                h('span', { class: 'label-sm server-state' }, stateLabel),
            ),
            status ? renderServerStats(status, t) : null,
            entry.error
                ? h('p', { class: 'body-md warning' }, t('desktop.servers.error', { message: entry.error }))
                : null,
            entry.invite
                ? h('div', {},
                    h('div', { class: 'invite-code' }, entry.invite),
                    h('div', { style: 'margin-top: 0.75rem;' },
                        h('button', { class: 'btn btn-secondary', onclick: () => copyText(entry.invite, 'desktop.peers.copied') }, t('desktop.peers.copy'))),
                )
                : null,
            h('p', { class: 'label-sm server-caps' },
                `${t('desktop.control.capabilities')}: ${caps.join(', ') || '—'}`),
            h('div', { class: 'choice-row server-actions' },
                canRead ? h('button', { class: 'btn btn-secondary', disabled: entry.busy ? '' : null, onclick: () => refreshServer(key) }, t('desktop.servers.refresh')) : null,
                can('invite:create') ? h('button', { class: 'btn btn-secondary', onclick: () => mintServerInvite(key) }, t('desktop.servers.mintInvite')) : null,
                can('export:create') ? h('button', { class: 'btn btn-secondary', onclick: () => exportServer(key) }, t('desktop.servers.export')) : null,
                can('service:shutdown')
                    ? h('button', { class: 'btn btn-danger', onclick: () => openDialog({ kind: 'server-shutdown', serverKey: key, serverName: server.name }) }, t('desktop.servers.shutdown'))
                    : null,
            ),
        )
    }

    function renderServerPairForm (t) {
        const codeInput = h('input', { class: 'input', placeholder: t('desktop.control.codePlaceholder') })
        const nameInput = h('input', { class: 'input', placeholder: t('desktop.control.namePlaceholder'), style: 'max-width: 220px;' })
        const pairAction = async () => {
            try {
                const result = await ownerControl.pair(codeInput.value, nameInput.value)
                if (result?.ok) {
                    store.pushNotice(t('desktop.control.paired'), 'success')
                    renderAll()
                } else {
                    store.pushNotice(`${t('desktop.control.pairFailed')} (${result?.reason ?? 'error'})`, 'error')
                }
            } catch (error) {
                store.pushNotice(`${t('desktop.control.pairFailed')} (${error?.message ?? 'error'})`, 'error')
            }
        }
        return h('div', { class: 'server-pair' },
            h('h3', { class: 'category-heading label-sm' }, t('desktop.servers.pairTitle')),
            h('p', { class: 'body-md pane-note' }, t('desktop.servers.pairHint')),
            h('div', { class: 'add-bar', style: 'margin-top: 1rem; margin-bottom: 0;' },
                codeInput,
                nameInput,
                h('button', { class: 'btn btn-primary', onclick: pairAction }, t('desktop.control.pair')),
            ),
        )
    }

    // Returns the section nodes; the pane supplies the surrounding layout.
    function buildServersSection (t) {
        const heading = h('div', { class: 'pane-section-head' },
            h('h3', { class: 'category-heading label-sm' }, t('desktop.servers.title')),
            ownerControl ? h('button', { class: 'btn btn-secondary', onclick: () => refreshAllServers() }, t('desktop.servers.refreshAll')) : null,
        )
        if (!ownerControl) {
            return h('section', { class: 'pane-section' }, heading,
                h('p', { class: 'body-md pane-note' }, t('desktop.control.unavailable')),
            )
        }
        const list = ownerControl.listServers()
        // Auto-query any status:read server we've never reached, so opening the
        // pane shows live status without a manual click. The busy guard in
        // refreshServer keeps re-renders from re-firing the in-flight request;
        // gating on the capability here avoids re-calling a no-op every render.
        for (const server of list) {
            if (servers[server.serverPublicKeyHex] === undefined && (server.capabilities ?? []).includes('status:read')) {
                refreshServer(server.serverPublicKeyHex, { silent: true })
            }
        }
        return h('section', { class: 'pane-section' }, heading,
            list.length === 0
                ? h('p', { class: 'body-md pane-note' }, t('desktop.servers.empty'))
                : h('div', { class: 'server-cards' }, ...list.map((server) => renderServerCard(server, t))),
            renderServerPairForm(t),
        )
    }

    return {
        buildServersSection,
        refreshServer,
        refreshAllServers,
        shutdownServer,
        // Exposed for tests and for assertions about cached state; the renderer
        // itself only reaches for the four above.
        serverCan,
        state: servers,
    }
}
