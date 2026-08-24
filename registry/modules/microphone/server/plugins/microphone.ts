import { Capture } from "../../src/capture"
import { resolveDevice } from "../../src/devices"

/**
 * One capture per configured microphone.
 *
 * Runs ONCE however many times the module is listed — multiplicity lives in
 * the options, and `axon.modules.all()` is how this one run learns it has
 * several devices to open.
 *
 * Streams every frame the microphone produces, unconditionally. No VAD, no
 * threshold, no "was this worth sending": deciding what a sound MEANS is
 * cognition, and cognition happens inside the cognet or not at all. A body
 * that filtered would be a body doing a small amount of thinking, and a
 * brain downstream of it could never know what it had been denied.
 */

type MicOptions = {
    device?: string
    rate?: number
    frameMs?: number
    channel?: string
}

const MICS = Symbol.for("axon.microphone.captures")
type Mics = {
    /** The runtime receiving frames — swapped on reload, never re-created. */
    target: { stim: (type: "cognet:stimulus:audio", data: Record<string, unknown>) => Promise<unknown> } | null
    stop: () => void
}
const store = globalThis as typeof globalThis & { [MICS]?: Mics }

export default defineAxonPlugin(async axon => {
    const running = store[MICS]
    if (running) {
        // A hot reload re-runs plugins in the same process. The devices stay
        // open and keep streaming; only the runtime they feed changes.
        running.target = axon
        return
    }

    const instances = axon.modules.all<MicOptions>("microphone")
    const captures: Array<{ stop: () => void }> = []

    for (const options of instances) {
        const rate = options.rate ?? 16_000
        const frameMs = options.frameMs ?? 32
        const channel = options.channel ?? "mic0"
        const selector = options.device ?? "auto"

        // Frame length in SAMPLES is what the capture slices on; ms is what
        // a human configures. Converted once, here, so the body owns the
        // arithmetic rather than every caller repeating it.
        const frameSamples = Math.round((frameMs / 1000) * rate)

        const device = await resolveDevice(selector, rate)
        if (!device) {
            // No microphone is an ordinary state — a server, a machine with
            // its mic unplugged. The agent runs without hearing, and nothing
            // downstream is told a microphone exists.
            console.warn(`[mic] ${channel}: no capture device available`)
            continue
        }

        let mic: ReturnType<typeof Capture>
        try {
            mic = Capture({ sampleRate: rate, frameSamples, device: device.id })
        } catch (cause) {
            console.warn(`[mic] ${channel}: ${cause instanceof Error ? cause.message : String(cause)}`)
            continue
        }

        captures.push(mic)
        // Says WHICH device `auto` chose. A module that resolves for you owes
        // you this, or the convenience is indistinguishable from a guess.
        console.log(`[mic] ${channel} ← ${device.name} via ${mic.backend} — ${rate}Hz, ${frameMs}ms frames`)

        const mime = `audio/pcm;rate=${rate};bits=16;ch=1`

        void (async () => {
            for await (const frame of mic.frames()) {
                // Bytes inline rather than behind a fetchable ref: a cognet
                // has no filesystem and no way to dereference a URI, so a
                // ref into a shared buffer would force the brain to reach
                // back into the body. Audio is sensory-tier — never in the
                // durable log, held in the bounded ring so the last minutes
                // stay watchable.
                await mics.target?.stim("cognet:stimulus:audio", {
                    channel,
                    ref: {
                        uri: `data:audio/pcm;base64,${Buffer.from(frame).toString("base64")}`,
                        mime,
                        bytes: frame.byteLength,
                    },
                    durationMs: frameMs,
                })
            }
        })().catch((cause: unknown) => {
            // A mic that died must say so, not quietly stop delivering.
            console.error(`[mic] ${channel} stopped:`, cause instanceof Error ? cause.message : cause)
        })
    }

    const mics: Mics = {
        target: axon,
        stop: () => {
            for (const capture of captures) capture.stop()
        },
    }
    store[MICS] = mics

    axon.hooks.hook("shutdown:before", () => {
        // A reload fires this too and must NOT stop the captures — they
        // outlive any one runtime. Detach only; the next runtime re-points
        // `target`. Process exit takes the recorders with it.
        if (mics.target === axon) mics.target = null
    })
})
