import { existsSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Display, Hearing, commandLineHas } from "../../body/index"
import type { ProcessesT } from "../../processes"
import { Streamer } from "./streamer"

type Process = ReturnType<ProcessesT["spawn"]>

const PORT = 52_640
const SLOT = 90
const WIDTH = 1280
const HEIGHT = 720

/**
 * The authoring client shown inside Fleet: its own X display and sound sink,
 * streamed to a browser frame. The client is the same one the desktop gets;
 * only where its window lives differs.
 */
export function Stream(opts: {
    dir: string
    root: string
    gameDir: string
    processes: ProcessesT
    /** Takes a process into the Studio's keeping; throws when the launch was cancelled meanwhile. */
    own: (process: Process, label: string) => void
    /** Whether the Studio is still starting or running. */
    live: () => boolean
    /** Called when the stream's sound fails. */
    fail: (reason: string) => void
}) {
    const windowReady = join(opts.dir, "window.ready")
    const screen = Display({ slot: SLOT, processes: opts.processes, dir: opts.dir, resolution: "4096x2160" })
    const hearing = Hearing({
        slot: SLOT,
        processes: opts.processes,
        dir: opts.dir,
        rate: 44_100,
        channels: 2,
        chunkSeconds: 0.1,
        kept: 0,
        owns: pid => commandLineHas(pid, opts.gameDir),
        onFailure: opts.fail,
        live: opts.live,
    })
    const streamer = Streamer({ root: join(opts.root, "streamer"), processes: opts.processes, display: screen.name, sink: hearing.sink, log: join(opts.dir, "stream.log") })
    let hearingOpen = false
    let screenPrepared = false
    let sessionToken: string | null = null

    async function ready(): Promise<void> {
        const deadline = Date.now() + 30_000
        while (Date.now() < deadline) {
            if (!opts.live()) throw new Error("Studio launch was cancelled")
            try {
                const response = await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(1000) })
                if (response.ok) return
            } catch {
                // A stream server still binding is expected during startup.
            }
            await Bun.sleep(200)
        }
        throw new Error("Minecraft Studio stream did not become ready within 30 seconds")
    }

    async function clientReady(): Promise<void> {
        const deadline = Date.now() + 60_000
        while (Date.now() < deadline) {
            if (!opts.live()) throw new Error("Studio launch was cancelled")
            if (existsSync(windowReady)) return
            await Bun.sleep(200)
        }
        throw new Error("Minecraft Studio client did not open a window within 60 seconds")
    }

    return {
        /** What the client's options must say to fit the frame and play into the stream's sink. */
        settings: {
            pauseOnLostFocus: "false", fullscreen: "false",
            overrideWidth: String(WIDTH), overrideHeight: String(HEIGHT),
            maxFps: "60", enableVsync: "false", rawMouseInput: "false",
            soundDevice: hearing.sink, skipMultiplayerWarning: "true",
        },
        /** The display, sound and stream, up; the environment the client must start in. */
        async open(): Promise<Record<string, string | undefined>> {
            await screen.prepare()
            screenPrepared = true
            if (!opts.live()) throw new Error("Studio launch was cancelled")
            await hearing.prepare()
            await hearing.open()
            hearingOpen = true
            if (!opts.live()) throw new Error("Studio launch was cancelled")
            opts.own(screen.start(), "Studio display")
            await Bun.sleep(300)
            await streamer.resize(WIDTH, HEIGHT)
            const masterToken = randomBytes(32).toString("base64url")
            sessionToken = randomBytes(32).toString("base64url")
            opts.own(await streamer.start(PORT, masterToken), "Studio stream")
            await ready()
            const provision = await fetch(`http://127.0.0.1:${PORT}/api/tokens`, {
                method: "POST",
                headers: { authorization: `Bearer ${masterToken}`, "content-type": "application/json" },
                body: JSON.stringify({ [sessionToken]: { role: "controller", slot: null, mk_control: true } }),
            })
            if (!provision.ok) throw new Error(`Studio stream refused controller token: HTTP ${provision.status} ${await provision.text()}`)
            return { DISPLAY: screen.name, WAYLAND_DISPLAY: undefined, XDG_SESSION_TYPE: "x11", SDL_VIDEODRIVER: "x11", PULSE_SINK: hearing.sink }
        },
        /** Once the client is started: its window kept flush with the display, and its sound bound. */
        async attach(): Promise<void> {
            await rm(windowReady, { force: true })
            opts.own(opts.processes.spawn({
                label: "minecraft-studio:window",
                cmd: ["python3.14", fileURLToPath(new URL("./window.py", import.meta.url)), windowReady],
                cwd: opts.gameDir,
                env: { DISPLAY: screen.name, PYTHONPATH: streamer.pythonPath },
                stdout: join(opts.dir, "window.log"),
            }), "Studio window")
            await clientReady()
            hearing.bind()
        },
        /** Where Fleet's frame points, controller token included. */
        url(): string {
            if (!sessionToken) throw new Error("Studio stream is not open")
            return `http://127.0.0.1:${PORT}/?token=${sessionToken}`
        },
        async close(): Promise<void> {
            sessionToken = null
            const cleanup = await Promise.allSettled([
                hearingOpen ? hearing.close() : Promise.resolve(),
                screenPrepared ? screen.release() : Promise.resolve(),
            ])
            if (cleanup[0]?.status === "fulfilled") hearingOpen = false
            if (cleanup[1]?.status === "fulfilled") screenPrepared = false
            const errors = cleanup.flatMap(result => result.status === "rejected" ? [result.reason] : [])
            if (errors.length > 0) throw new AggregateError(errors, "Could not fully close the Studio stream")
        },
    }
}

export type StreamT = ReturnType<typeof Stream>
