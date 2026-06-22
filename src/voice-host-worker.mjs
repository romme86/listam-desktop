// Desktop voice host — runs the leaf-audio → STT → intent → write pipeline
// INSIDE the Pear worker, writing items into the DESKTOP's own base (via the
// injected `callBackend`), so a voice "yo aggiungi latte" appears in the desktop
// list directly. No separate peer, no second base, no pairing round-trip — this
// is the whole point of the redesign (the old leaf-hub ran an orphan base).
//
// Reuses the shared, runtime-injected voice modules unchanged:
//   audio-bridge (bare-tcp listener) · voice-bridge (utterance assembler) ·
//   bare-whisper STT (bare-subprocess) · voice-controller · voice-feedback (LED).
// `load()` is injected by backend-worker.mjs so the bare-* graph is imported
// only when voice is actually enabled.
import { RPC_ADD, RPC_DELETE } from '@listam/protocol'

export const DEFAULT_VOICE_PORT = 9994

function mutationOk (raw) {
    if (raw == null) return true
    try { const p = typeof raw === 'string' ? JSON.parse(raw) : raw; return p?.ok !== false } catch { return true }
}

// Per-locale initial whisper prompt — biases STT toward the command vocabulary
// AND reinforces the spoken language so Italian audio stops drifting to English.
// DUPLICATED from listam-headless/src/config.mjs (polyrepo; keep in sync).
const DEFAULT_VOICE_PROMPTS = {
    en: 'yo add milk. yo add bread. yo remove eggs. grocery list: milk, bread, eggs, tomatoes, pasta, coffee.',
    it: 'yo aggiungi latte. yo aggiungi pane. yo togli uova. lista della spesa: latte, pane, uova, pomodori, pasta, caffè.',
    es: 'yo añade leche. yo añade pan. yo quita huevos. lista de la compra: leche, pan, huevos, tomates, pasta, café.',
    de: 'yo füge Milch hinzu. yo füge Brot hinzu. yo entferne Eier. Einkaufsliste: Milch, Brot, Eier, Tomaten, Nudeln, Kaffee.',
    fr: 'yo ajoute du lait. yo ajoute du pain. yo enlève les œufs. liste de courses : lait, pain, œufs, tomates, pâtes, café.',
    pt: 'yo adiciona leite. yo adiciona pão. yo remove ovos. lista de compras: leite, pão, ovos, tomates, massa, café.',
}

function buildExtraArgs (config) {
    const extra = []
    // Explicit prompt wins; else the per-locale default for a concrete locale.
    const locale = config.locale || 'auto'
    const prompt = config.prompt || (locale !== 'auto' ? DEFAULT_VOICE_PROMPTS[locale] : null)
    if (prompt) extra.push('--prompt', String(prompt))
    if (Array.isArray(config.extraArgs)) extra.push(...config.extraArgs.map(String))
    return extra
}

// Tee the pipeline's [voice]/[stt]/[voice-bridge] log lines to a file next to
// the app storage (GUI worker stdout is otherwise lost), so the transcript +
// parsed intent + gate decisions are diagnosable. Capped, overwrite-whole
// (bare-fs append flags are unreliable).
function createFileLogger (baseLog, fs, path) {
    const lines = []
    const rec = (m) => {
        try { lines.push(`[${new Date().toISOString()}] ${m}`) } catch { lines.push(String(m)) }
        if (lines.length > 200) lines.shift()
        try { fs.writeFileSync(path, lines.join('\n') + '\n') } catch { /* best effort */ }
    }
    return {
        info: (m) => { try { baseLog?.info?.(m) } catch {} rec(m) },
        error: (m) => { try { baseLog?.error?.(m) } catch {} rec(m) },
        log: (m) => { try { baseLog?.log?.(m) } catch {} rec(m) },
    }
}

export function createVoiceHost ({ callBackend, getItems, load, log = null, publish = null } = {}) {
    let running = false
    let bridge = null
    let lastError = null
    let port = DEFAULT_VOICE_PORT

    function status () { return { running, port, error: lastError } }
    function publishStatus () { try { publish?.(status()) } catch { /* ignore */ } }

    async function start (config = {}) {
        if (running) return status()
        lastError = null
        port = Number(config.audioPort) > 0 ? Number(config.audioPort) : DEFAULT_VOICE_PORT
        try {
            const {
                tcp, subprocess, fs, tmpDir,
                createStt, startAudioBridge, createVoiceController, createVoiceFeedbackHandler,
                parseIntent, detectWake, isRegistryItem, isLabelItem,
            } = await load()

            const vlog = createFileLogger(log, fs, `${tmpDir}/voice.log`)
            vlog.info(`[voice] starting — model=${config.modelPath || '(unset)'} locale=${config.locale || 'auto'} port=${port}`)

            // Resolve the whisper-cli binary. The Settings UI only takes the model
            // path, so a bare 'whisper-cli' default would ENOENT (the Pear app's
            // PATH lacks it). Derive it from the standard whisper.cpp layout
            // (<root>/models/X.bin → <root>/build/bin/whisper-cli) when unset.
            let binPath = config.binPath
            if (!binPath && config.modelPath && /\/models\/[^/]+$/.test(config.modelPath)) {
                const guess = config.modelPath.replace(/\/models\/[^/]+$/, '/build/bin/whisper-cli')
                try { fs.statSync(guess); binPath = guess; vlog.info(`[voice] derived whisper-cli: ${guess}`) } catch { /* fall through */ }
            }
            if (!binPath) binPath = 'whisper-cli'

            const stt = createStt({
                engine: 'whisper-bare',
                config: { binPath, modelPath: config.modelPath, extraArgs: buildExtraArgs(config) },
                logger: vlog,
                runtime: { subprocess, fs, tmpDir },
            })
            if (!(await stt.available())) {
                throw new Error(`whisper model not found at ${config.modelPath || '(unset)'}`)
            }

            const controller = createVoiceController({
                addItem: async (text, listId, listType) => mutationOk(await callBackend(RPC_ADD, { text, listId, listType })),
                deleteItem: async (item) => mutationOk(await callBackend(RPC_DELETE, { item })),
                // Real list items only (never match a label/registry meta-item on remove).
                getAllItems: async () => (getItems?.() ?? []).filter((i) => !isLabelItem?.(i) && !isRegistryItem?.(i)),
                getRegistryItems: async () => (getItems?.() ?? []).filter((i) => isRegistryItem?.(i)),
                notesListId: config.notesListId || 'voicenotes',
                logger: vlog,
            })

            const onUtterance = createVoiceFeedbackHandler({
                stt, controller, parseIntent, detectWake,
                locale: config.locale || 'auto',
                logger: vlog,
            })

            bridge = await startAudioBridge({ tcp, port, onUtterance, logger: vlog })
            port = bridge.port
            running = true
            log?.info?.(`[voice] desktop audio bridge listening on :${port}`)
        } catch (err) {
            lastError = err?.message ?? String(err)
            running = false
            log?.error?.('[voice] start failed', { message: lastError })
        }
        publishStatus()
        return status()
    }

    async function stop () {
        if (bridge) { try { await bridge.close() } catch { /* ignore */ } bridge = null }
        running = false
        lastError = null
        publishStatus()
        return status()
    }

    async function handleAction (frame = {}) {
        if (frame.action === 'start') return start(frame.config || {})
        if (frame.action === 'stop') return stop()
        return status()
    }

    return { start, stop, handleAction, status, publishStatus }
}
