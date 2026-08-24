import { Capture } from "../../src/ears/capture"

/**
 * Ears — the body's audio input.
 *
 * Streams every frame the microphone produces, unconditionally. There is no
 * VAD here, no threshold, no "was this worth sending": deciding what a sound
 * MEANS is cognition, and cognition happens inside the cognet or not at all.
 * A body that filtered would be a body doing a small amount of thinking, and
 * a brain downstream of it could never know what it had been denied.
 *
 * It also does not wake the brain. How fast frames arrive is a property of
 * this microphone; how often it is worth thinking about them is a property of
 * whatever mind is listening, and that mind drives its own `kernel.wake()`.
 *
 * The mic is on whenever the agent is running. That is the honest reading of
 * an agent whose cognet declares it can hear — and the user's control over it
 * belongs at a consent surface, not to this plugin second-guessing them.
 */

/** 16kHz mono is what speech models want and what every mic gives cheaply. */
const SAMPLE_RATE = 16_000

/** 512 samples = 32ms — Silero VAD's native window. See CaptureOpts. */
const FRAME_SAMPLES = 512
const FRAME_MS = Math.round((FRAME_SAMPLES / SAMPLE_RATE) * 1000)

/**
 * The frames' own format, carried on every stimulus so the brain reads what
 * it was given rather than assuming a rate. A cognet that hard-coded 16kHz
 * would be asserting a property of a body it has not met.
 */
const MIME = `audio/pcm;rate=${SAMPLE_RATE};bits=16;ch=1`

/**
 * A live capture survives a hot reload — plugins re-run without the process
 * restarting, and `shutdown:before` only fires on real shutdown. Without this
 * every reload would leave another `arecord` holding the device, and the
 * second one usually fails to open it at all.
 */
const EARS = Symbol.for("vox.ears")
const store = globalThis as typeof globalThis & { [EARS]?: { stop: () => void } }

export default defineAxonPlugin(axon => {
    store[EARS]?.stop()

    const mic = Capture({ sampleRate: SAMPLE_RATE, frameSamples: FRAME_SAMPLES })
    store[EARS] = mic

    // Detached: this generator runs for the life of the agent, and awaiting it
    // here would never return. The catch is the boundary — a mic that died
    // must say so, not quietly stop delivering.
    void (async () => {
        for await (const frame of mic.frames()) {
            // Bytes inline rather than behind a fetchable ref. A cognet has no
            // filesystem and no way to dereference a URI, so a ref into a
            // shared buffer would force the brain to reach back into the body
            // — the coupling this architecture removes everywhere else.
            //
            // Audio is a SENSORY-tier stimulus: never in the durable log, but
            // held in the session's bounded ring so a debugger can show the
            // last minute of what was heard. Delivery is unaffected either
            // way — the cognet gets this frame at its next wake regardless.
            await axon.stim("cognet:stimulus:audio", {
                channel: "mic0",
                ref: {
                    uri: `data:audio/pcm;base64,${Buffer.from(frame).toString("base64")}`,
                    mime: MIME,
                    bytes: frame.byteLength,
                },
                durationMs: FRAME_MS,
            })
        }
    })().catch(cause => {
        console.error("[ears] capture stopped:", cause)
    })

    axon.hooks.hook("shutdown:before", () => {
        mic.stop()
        delete store[EARS]
    })
})
