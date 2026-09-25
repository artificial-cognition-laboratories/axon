import { decodeDataUri, parsePcm } from "../../src/formats"
import { play } from "../../src/playback"
import { resolveDevice } from "../../src/devices"

type SpeakerOptions = { device?: string }

const SPEAKER = Symbol.for("axon.speaker")
type Running = {
    target: unknown
    stop: () => void
}
const store = globalThis as typeof globalThis & { [SPEAKER]?: Running }

export default defineAxonPlugin(axon => {
    const existing = store[SPEAKER]
    if (existing) {
        existing.target = axon
        return
    }

    const options = axon.modules.all<SpeakerOptions>("speaker")[0] ?? {}
    const selector = options.device ?? "auto"
    const device = resolveDevice(selector)

    let current: ReturnType<typeof play> | null = null
    let closed = false

    if (!device) {
        console.warn(`[speaker] no output device for "${selector}" — agent continues without audio`)
    } else {
        console.log(`[speaker] ${device.name} (${device.id})`)
    }

    const stop = () => {
        closed = true
        current?.stop()
        current = null
    }

    store[SPEAKER] = { target: axon, stop }

    axon.on("cognet:output:audio", async event => {
        if (closed || !device) return

        const format = parsePcm(event.ref.mime)
        if (!format) {
            console.warn(`[speaker] unsupported audio format: ${event.ref.mime}`)
            return
        }

        const pcm = decodeDataUri(event.ref.uri)
        if (!pcm) {
            console.warn("[speaker] audio output is not a base64 data URI")
            return
        }

        if (event.ref.bytes !== undefined && event.ref.bytes !== pcm.byteLength) {
            console.warn(`[speaker] byte count mismatch: declared ${event.ref.bytes}, received ${pcm.byteLength}`)
            return
        }

        if (pcm.byteLength % (format.channels * 2) !== 0) {
            console.warn("[speaker] PCM payload is not aligned to its channel count")
            return
        }

        try {
            current?.stop()
            current = play(pcm, format, device.id)
            const active = current
            const result = await active.done
            if (!result.ok && !closed) console.warn(`[speaker] playback exited with code ${result.exitCode}`)
            if (current === active) current = null
        } catch (cause) {
            if (!closed) console.warn(`[speaker] playback failed: ${cause instanceof Error ? cause.message : String(cause)}`)
        }
    })

    axon.hooks.hook("shutdown:before", () => {
        if (store[SPEAKER]?.target === axon) {
            stop()
            delete store[SPEAKER]
        }
    })
})
