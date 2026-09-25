import { state, takeUtterance, MAX_UTTERANCE_FRAMES } from "./state"
import { think } from "./cortex"
import { TTS_SAMPLE_RATE } from "./tts"

const MIN_SPEECH = 0.085
const SPEECH_MARGIN = 2.0
const NOISE_ADAPT = 0.03
const OPEN_AFTER = 3
const CLOSE_AFTER = 24

function encode(pcm: Int16Array): string {
    const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
    let binary = ""
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    }
    return btoa(binary)
}

function decode(uri: string): Int16Array | null {
    const comma = uri.indexOf(",")
    if (comma < 0 || !uri.startsWith("data:")) return null
    const bytes = Uint8Array.from(atob(uri.slice(comma + 1)), c => c.charCodeAt(0))
    return new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2)
}

/** Cheap local speech gate until a stream VAD provider is configured. */
function energy(pcm: Int16Array): number {
    if (!pcm.length) return 0
    let sum = 0
    for (const sample of pcm) {
        const normalized = sample / 32768
        sum += normalized * normalized
    }
    return Math.sqrt(sum / pcm.length)
}

loop(async ({ stimuli, stop }) => {
    const frames = await phase("hear", async () => {
        let count = 0

        for (const stimulus of stimuli) {
            if (stimulus.type !== "cognet:stimulus:audio") continue

            const pcm = decode(stimulus.data.ref.uri)
            if (!pcm) continue

            const level = energy(pcm)
            state.speech = level
            // Learn the idle floor only while closed. The detector must not
            // chase a person's voice upward while an utterance is open.
            if (!state.speaking) {
                state.noiseFloor += (level - state.noiseFloor) * NOISE_ADAPT
            }
            const speechThreshold = Math.max(MIN_SPEECH, state.noiseFloor * SPEECH_MARGIN)
            state.heardMs += Number(stimulus.data.durationMs ?? 0)
            count++

            if (state.speaking || state.speechFrames > 0) {
                state.utterance.push(pcm)
                if (state.utterance.length > MAX_UTTERANCE_FRAMES) state.utterance.shift()
            }

            if (level >= speechThreshold) {
                state.speechFrames++
                state.silenceFrames = 0
            } else {
                state.silenceFrames++
                state.speechFrames = 0
            }
        }

        return count
    })

    if (frames === 0) return stop()

    if (!state.speaking && state.speechFrames >= OPEN_AFTER) {
        state.speaking = true
        if (state.thinking && state.replyAbort) {
            state.replyAbort.abort()
            state.interruptions++
            console.log("— interrupted")
        }
        console.log("▶ speech started (level=", state.speech.toFixed(3), ")")
    }

    if (state.speaking && state.silenceFrames >= CLOSE_AFTER) {
        state.speaking = false

        const utterance = takeUtterance()
        const seconds = utterance.length / 16000
        console.log("■ speech ended —", seconds.toFixed(1), "s of audio, wake", kernel.clock().wakes)

        if (kernel.engine.has("asr") && utterance.length > 0 && !state.transcribing) {
            state.transcribing = true
            void transcribe(utterance).finally(() => { state.transcribing = false })
        }
    }

    stop()
})

async function transcribe(utterance: Int16Array): Promise<void> {
    const started = Date.now()
    try {
        const text = await kernel.engine("asr").transform(encode(utterance))
        if (!text) return

        console.log(`“${text}”  (${Date.now() - started}ms)`)
        if (state.thinking) return

        state.thinking = true
        state.replyAbort = new AbortController()
        try {
            const reply = await think(text, state.replyAbort.signal)
            if (!reply) return

            console.log(`▶ ${reply.text}  (${reply.ms}ms)`)
            await kernel.output("cognet:output:text", { channel: "reply", content: reply.text })

            if (kernel.engine.has("tts")) {
                const pcm = await kernel.engine("tts").request({
                    messages: [{ role: "user", content: reply.text }],
                })
                await kernel.output("cognet:output:audio", {
                    channel: "speaker",
                    ref: {
                        uri: `data:audio/pcm;base64,${encode(pcm)}`,
                        mime: `audio/pcm;rate=${TTS_SAMPLE_RATE};bits=16;ch=1`,
                        bytes: pcm.byteLength,
                    },
                    transcript: reply.text,
                    durationMs: Math.round((pcm.length / TTS_SAMPLE_RATE) * 1000),
                })
            }
        } finally {
            state.thinking = false
            state.replyAbort = null
        }
    } catch (cause) {
        console.error("[vox] failed:", cause)
    }
}
