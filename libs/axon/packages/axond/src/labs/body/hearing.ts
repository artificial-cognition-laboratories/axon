import { readFileSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { err } from "@arcforge/err"
import { trim } from "./captures"
import type { ProcessesT } from "../processes"

export type HearingOpts = {
    /** Numbers this body's sink, so a restarted body reuses its own. */
    slot: number
    processes: ProcessesT
    /** The body's folder. Audio lands in `hearing/` inside it. */
    dir: string
    rate: number
    channels: number
    /** Seconds per captured chunk. */
    chunkSeconds: number
    kept: number
    /**
     * Is this process the client this body owns?
     *
     * Asked rather than decided, because the answer is the one genuinely
     * engine-specific thing here: it matches the client's command line, and
     * what is on that command line differs per engine.
     */
    owns(pid: number): boolean
    /** The watcher runs on a timer with no caller to throw at, so it reports here. */
    onFailure(reason: string): void
    /** Whether the body is still alive — the watcher stops when it is not. */
    live(): boolean
}

/** How often a stray stream is noticed and moved back. */
const BIND_MS = 2_000

/**
 * Hearing — a body's virtual ears, and the audio captured from them.
 *
 * A null sink of this body's own — virtual speakers, exactly as the display is
 * a virtual screen. The client plays into it, nothing reaches the machine's
 * real output, and its `.monitor` source is what the capture reads.
 *
 * Engine-neutral because it never speaks to the game: it moves whatever audio
 * streams the client opens onto this body's sink, by asking `owns()` which pid
 * is ours. That works whether the client renders sound through SDL, OpenAL or
 * anything else.
 */
export function Hearing(opts: HearingOpts) {
    const dir = join(opts.dir, "hearing")
    const sink = `axon-body-${opts.slot}`
    let watcher: ReturnType<typeof setInterval> | null = null

    /** Run one audio-server command. A failed command is a failed body boundary. */
    async function pactl(args: string[]): Promise<string> {
        const proc = Bun.spawn(["pactl", ...args], { stdout: "pipe", stderr: "pipe" })
        const [out, stderr, code] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
        ])
        if (code !== 0) throw new Error(`pactl ${args.join(" ")} exited ${code}: ${stderr.trim() || "no error output"}`)
        return out
    }

    /** Move every stream belonging to this body's client onto its sink. */
    async function park(): Promise<void> {
        const inputs = await pactl(["list", "sink-inputs"])
        if (inputs === "") return

        const ours = await pactl(["list", "short", "sinks"])
        const id = ours.split("\n").find(line => line.split("\t")[1] === sink)?.split("\t")[0]
        if (!id) throw new Error(`audio sink ${sink} disappeared while its client was running`)

        for (const block of inputs.split("Sink Input #").slice(1)) {
            const input = block.slice(0, block.indexOf("\n")).trim()
            const owner = /application\.process\.id = "(\d+)"/.exec(block)?.[1]
            const on = /Sink:\s*(\d+)/.exec(block)?.[1]
            if (!input || !owner || on === id) continue
            if (!opts.owns(Number(owner))) continue
            await pactl(["move-sink-input", input, sink])
        }
    }

    return {
        /** Where captured stereo audio lands, newest last. */
        dir: dir,
        /** The sink name, for pinning the client's audio at launch. */
        sink: sink,

        prepare(): Promise<string | undefined> {
            return mkdir(dir, { recursive: true })
        },

        /**
         * Load this body's null sink, idempotently.
         *
         * Named after the slot so a restarted body reuses its own rather than
         * accumulating one per boot. Already-loaded is success: `pactl` fails
         * when the name is taken, and that is precisely the state we want.
         *
         * Called BEFORE the client, for the same reason the display is: audio
         * backends bind their device at startup and will not find a sink that
         * does not exist yet.
         */
        async open(): Promise<void> {
            const existing = await pactl(["list", "short", "sinks"])
            if (existing.includes(sink)) return

            const loaded = await pactl([
                "load-module", "module-null-sink",
                `sink_name=${sink}`,
                `sink_properties=device.description=${sink}`,
            ])
            if (loaded.trim() === "") {
                throw err("WORLD_BODY_FAILED", {
                    detail: `body ${opts.slot} could not create its audio sink — is PipeWire or PulseAudio running?`,
                    context: { slot: opts.slot, sink: sink },
                })
            }
        },

        /**
         * Segmented wavs rather than one stream, so the reader can take a
         * settled file and delete it — the same contract the frames use, and
         * the reason neither capture needs a protocol.
         */
        start(): ReturnType<ProcessesT["spawn"]> {
            return opts.processes.spawn({
                label: `hearing:${sink}`,
                cmd: [
                    "ffmpeg", "-loglevel", "error", "-y",
                    "-f", "pulse", "-ac", String(opts.channels), "-ar", String(opts.rate), "-i", `${sink}.monitor`,
                    "-f", "segment", "-segment_time", String(opts.chunkSeconds), "-reset_timestamps", "1",
                    "-c:a", "pcm_s16le", "-start_number", "0", join(dir, "chunk_%08d.wav"),
                ],
                stdout: join(opts.dir, "hearing.log"),
            })
        },

        /**
         * Keep this client's audio parked on this body's sink.
         *
         * A watcher rather than a one-off, for two reasons. A client may open
         * its stream LAZILY — nothing exists to move until the first sound
         * plays, which may be minutes after boot — and stream-restore
         * re-applies its remembered sink whenever a stream is recreated. One
         * move at startup would find nothing and then be undone.
         *
         * Started AFTER the capture, so nothing is missed between the stream
         * moving and the recorder starting.
         */
        bind(): void {
            const timer = setInterval(() => {
                if (!opts.live()) {
                    clearInterval(timer)
                    return
                }
                void park().catch(cause => {
                    if (!opts.live()) return
                    opts.onFailure(`could not route body audio: ${cause instanceof Error ? cause.message : String(cause)}`)
                })
            }, BIND_MS)

            // `unref` so a body waiting on nothing else cannot hold the daemon open.
            timer.unref?.()
            watcher = timer
        },

        /** Drop all but the newest chunks. */
        prune(): Promise<void> {
            return trim(dir, ".wav", opts.kept)
        },

        /**
         * Unload this body's virtual ears.
         *
         * The sink outlives the processes that used it; leaving one behind per
         * body would litter the machine's audio graph until reboot.
         */
        async close(): Promise<void> {
            if (watcher) clearInterval(watcher)
            watcher = null
            const modules = await pactl(["list", "short", "modules"])
            for (const line of modules.split("\n")) {
                if (!line.includes(`sink_name=${sink}`)) continue
                const id = line.split(/\s+/)[0]
                if (!id) continue
                try {
                    await pactl(["unload-module", id])
                } catch (cause) {
                    // Another body or audio-server restart may remove the module
                    // after the listing. Only an observed absence counts as closed —
                    // and the audio server answering "No such entity" IS one: on
                    // PipeWire its module list lags an unload, so asking the list
                    // again right after still shows the module that is gone.
                    if (cause instanceof Error && cause.message.includes("No such entity")) continue
                    const remaining = await pactl(["list", "short", "modules"])
                    if (remaining.split("\n").some(entry => entry.split(/\s+/)[0] === id)) throw cause
                }
            }
        },
    }
}

export type HearingT = ReturnType<typeof Hearing>

/**
 * Whether `pid`'s command line contains `argument` as a whole argument.
 *
 * The predicate every engine's `owns()` is built from. Read from /proc rather
 * than shelled out to: this runs every couple of seconds per body, and `ps`
 * would be a process spawn to answer a question a file already holds.
 * Arguments are NUL-separated, so a directory is one whole argument and cannot
 * match a prefix of another body's.
 */
export function commandLineHas(pid: number, argument: string): boolean {
    try {
        return readFileSync(`/proc/${pid}/cmdline`, "utf-8").split("\0").includes(argument)
    } catch {
        // The process exited between listing the stream and reading it. Not an
        // error: the stream is about to disappear too.
        return false
    }
}
