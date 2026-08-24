/**
 * The body's voice.
 *
 * Subscribes to the brain's audio output and plays it. That is the whole job:
 * the brain emits a fact ("here is some sound"), and what becomes of it is the
 * body's business — a speaker here, a WebRTC track elsewhere, a file in a
 * test. The cognet has no idea which, and no idea whether anything is
 * listening at all.
 *
 * Mirror image of the ears: that plugin turns a device into stimuli without
 * judging them, this one turns emissions into sound without interpreting
 * them.
 */

/** Kokoro's rate. Read from the mime rather than assumed — the brain declares it. */
const DEFAULT_RATE = 24_000

function rateOf(mime: string): number {
    const match = mime.match(/rate=(\d+)/)
    return match ? Number(match[1]) : DEFAULT_RATE
}

/** `data:...;base64,<payload>` → raw bytes. */
function decode(uri: string): Uint8Array | null {
    const comma = uri.indexOf(",")
    if (comma === -1 || !uri.startsWith("data:")) return null
    return Uint8Array.from(atob(uri.slice(comma + 1)), c => c.charCodeAt(0))
}

/**
 * A live player survives a hot reload — plugins re-run without the process
 * restarting, so without this every reload would leave another `aplay`
 * holding the device.
 */
const VOICE = Symbol.for("vox.voice")
const store = globalThis as typeof globalThis & { [VOICE]?: { stop: () => void } }

export default defineAxonPlugin(axon => {
    store[VOICE]?.stop()

    let current: ReturnType<typeof Bun.spawn> | null = null
    store[VOICE] = { stop: () => { current?.kill(); current = null } }

    axon.on("cognet:output:audio", async event => {
        const pcm = decode(event.ref.uri)
        if (!pcm) return

        // Interrupt whatever is already playing. If the brain has emitted new
        // audio, the old audio is what it was replacing — and a voice talking
        // over itself is worse than one that cuts cleanly.
        current?.kill()

        const proc = Bun.spawn(
            ["aplay", "-t", "raw", "-f", "S16_LE", "-r", String(rateOf(event.ref.mime)), "-c", "1", "-q", "-"],
            { stdin: "pipe", stdout: "ignore", stderr: "pipe" },
        )
        current = proc

        proc.stdin.write(pcm)
        proc.stdin.end()
        await proc.exited
        if (current === proc) current = null
    })

    axon.hooks.hook("shutdown:before", () => {
        current?.kill()
        delete store[VOICE]
    })
})
