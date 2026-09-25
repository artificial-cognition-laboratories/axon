import { existsSync, readFileSync } from "node:fs"
import { copyFile, mkdir, readdir, readFile, rm, stat } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { err } from "@arcforge/err"
import { Control, type ControlT } from "./control"
import type { InstallT } from "./install"
import type { ProcessesT } from "./processes"
import type { BodyInfo, BodyState } from "./types"

export type BodyOpts = {
    id: string
    /** Distinct per body: picks its display and bridge port. */
    slot: number
    install: InstallT
    processes: ProcessesT
}

/** The client renders here; ffmpeg captures the same size. */
const RESOLUTION = "1280x720"
const CAPTURE_FPS = 24

/**
 * The body's ears.
 *
 * Stereo because direction has to come from somewhere, and Terraria's mixer
 * already pans every sound by its position relative to the camera and
 * attenuates it by distance. So a stereo capture of the game's own output
 * carries the direction cue a listener actually uses (the level difference
 * between ears) without anyone reading game state — the mixer IS the
 * propagation model, and it is the same signal a person at the speakers gets.
 *
 * 22.05kHz is deliberate: Terraria's effects carry nothing meaningful above
 * 11kHz, and halving the rate halves every downstream pass for nothing lost.
 */
const AUDIO_RATE = 22_050
const AUDIO_CHANNELS = 2
/**
 * Seconds per captured chunk.
 *
 * Short enough that a sound's onset is localised in time to within a chunk —
 * which is what an onset detector needs — and long enough that the file count
 * stays sane. At 100ms a body writes ten small wavs a second.
 */
const AUDIO_CHUNK_S = 0.1
/**
 * How often to check that this client's audio is still on its own sink.
 *
 * Slow: the stream is created once and moved once, and this exists only to
 * catch the lazy creation and any re-application by stream-restore.
 */
const AUDIO_BIND_MS = 2_000
/** A cold tModLoader client takes a while to reach its menu. */
const BOOT_MS = 180_000
/** Server connect, handshake, world download. */
const JOIN_MS = 120_000

/**
 * The client's settings, written before its first launch.
 *
 * A fresh save folder boots to tModLoader's first-run "Select language"
 * screen and waits there for a click nobody will make — the body sat
 * "booting" forever. Language set and the version marked as seen skips every
 * first-launch screen. The window fills the display so the capture records
 * the game rather than black bars.
 */
function clientConfig(input: { width: number; height: number; seen: Record<string, unknown> }): Record<string, unknown> {
    const { width, height } = input
    return {
        ...input.seen,
        Language: "en-US",
        SeenFirstLaunchModderWelcomeMessage: true,
        // Bodies load exactly the lab's staged mods — never whatever a server offers.
        DownloadModsFromServers: false,
        ClientUUID: randomUUID(),
        Fullscreen: false,
        WindowMaximized: false,
        WindowBorderless: true,
        DisplayWidth: width,
        DisplayHeight: height,
        AutoPause: false,
        AutoSave: true,
        QuickLaunch: false,
        // Somebody DOES hear it now. These were all zero while the client
        // played into a dummy device, and a muted body is a deaf organism: the
        // capture ran, wrote perfectly-sized chunks, and every sample was zero.
        //
        // Music stays off, and that is not an oversight. A soundtrack is
        // non-diegetic — it is not a sound anything in the world made, so an
        // organism hearing it would be localising something that does not
        // exist. Effects and ambience are events in the world; the score is not.
        VolumeSound: 1,
        VolumeAmbient: 1,
        VolumeMusic: 0,
        // A body renders in software on a virtual display and cannot draw 60
        // frames a second. Under the default frame skip ("Subtle") the whole
        // simulation slowed to match — measured at ~40% of real time — while
        // the server and every other client kept moving the body at full
        // speed from its last velocity, then snapped it back when its true
        // position arrived: the "teleporting" agent. "On" keeps updates at 60
        // and skips draws instead; capture only takes 24 a second anyway.
        FrameSkipMode: FRAME_SKIP_ON,
        // Cheaper draws, same scene: particle and water detail only.
        // Lighting is deliberately untouched — it changes what the agent sees.
        GraphicsQuality: QUALITY_LOW,
        WaveQuality: 0,
        // No map, mini or full. A map is a GPS no organism has — where the
        // body is, drawn on the screen — and the minimap's scrolling interior
        // is the one part of the HUD that moves, which vision reads as motion.
        MapEnabled: false,
    }
}

/** Terraria's FrameSkipMode: 0 off, 1 on, 2 subtle. */
const FRAME_SKIP_ON = 1
/** Terraria's GraphicsQuality: 0 auto, 1 high, 2 medium, 3 low. */
const QUALITY_LOW = 3

/**
 * Frames kept on disk. Capture runs whether or not an agent is inside, and an
 * agent consumes and deletes what it reads — so an unleased body would
 * otherwise write ~1MB a second forever.
 */
const FRAMES_KEPT = 48

/** Files that ARE a character: the vanilla save and tModLoader's modded data beside it. */
const CHARACTER_FILES = [".plr", ".tplr"]

/**
 * Body — one warm game client: a virtual display, tModLoader at its menu, the
 * AxonT bridge, and a frame capture of what it renders.
 *
 * The expensive part of embodiment is booting the client, so it is done
 * BEFORE anyone needs a body, and a body outlives every agent that uses it.
 * An agent possessing one costs a server join; a brain reload costs nothing.
 *
 * The display, the client, and the capture are three processes with one
 * lifetime. When any of them dies the body is `failed` and the pool replaces
 * it — a half-alive body (a client whose capture died) would hand an agent
 * eyes that show nothing, which is the failure this experiment cannot afford
 * to have silently.
 */
/** Keep the newest `kept` files with this extension; delete the rest. */
async function trim(dir: string, extension: string, kept: number): Promise<void> {
    if (!existsSync(dir)) return
    const names = (await readdir(dir)).filter(name => name.endsWith(extension)).sort()
    await Promise.all(names.slice(0, -kept).map(name => rm(join(dir, name), { force: true })))
}

export function Body(opts: BodyOpts) {
    const { install, processes } = opts
    const dir = join(install.lab.bodies, opts.id)
    const saveDir = join(dir, "tml")
    const frames = join(dir, "vision")
    const audio = join(dir, "hearing")
    const discovery = join(dir, "bridge.json")
    const display = `:${100 + opts.slot}`
    /**
     * A null sink of this body's own — virtual speakers, exactly as the display
     * is a virtual screen. The client plays into it, nothing reaches the
     * machine's real output, and its `.monitor` source is what the capture
     * reads.
     */
    const sink = `axon-body-${opts.slot}`
    const port = 52_400 + opts.slot
    const bridge = `ws://127.0.0.1:${port}/bridge`

    let state: BodyState = "booting"
    let session = "detached"
    let character: string | null = null
    let error: string | null = null
    let control: ControlT | null = null
    let audioBinder: ReturnType<typeof setInterval> | null = null
    const startedAt = new Date().toISOString()
    const procs: Array<ReturnType<ProcessesT["spawn"]>> = []

    function move(next: BodyState, why: string | null = null): void {
        state = next
        if (next === "failed") error = why
    }

    /** Waits for the client to report a session state, or throws after `ms`. */
    async function awaitSession(target: string, ms: number): Promise<void> {
        const deadline = Date.now() + ms
        while (session !== target) {
            if (state === "failed" || state === "stopped") throw new Error(error ?? `body ${state}`)
            if (Date.now() > deadline) throw new Error(`stayed '${session}' instead of reaching '${target}' within ${ms / 1000}s`)
            await Bun.sleep(100)
        }
    }

    /**
     * What the game printed before it gave up.
     *
     * tModLoader reports a fatal condition — Steam not running, a mod that
     * will not load — to its log and then sits on a dialog nobody will click.
     * Without this the lab waits out the whole boot timeout and reports "the
     * client did not open its bridge", which names the symptom and hides the
     * cause.
     */
    async function fatal(): Promise<string | null> {
        const log = join(dir, "client.log")
        if (!existsSync(log)) return null
        const text = await readFile(log, "utf-8")
        const line = text.split("\n").reverse().find(entry => entry.includes("/FATAL]"))
        if (!line) return null
        const said = line.slice(line.indexOf("/FATAL]") + "/FATAL]".length).trim()
        return said.length > 0 ? said : null
    }

    async function awaitDiscovery(since: number): Promise<void> {
        const deadline = Date.now() + BOOT_MS
        while (Date.now() < deadline) {
            if (state === "failed" || state === "stopped") throw new Error(error ?? `body ${state} while booting`)
            const said = await fatal()
            if (said) throw new Error(said)
            const written = existsSync(discovery) ? (await stat(discovery)).mtimeMs : 0
            if (written >= since) {
                const record = JSON.parse(await readFile(discovery, "utf-8")) as { endpoint?: string }
                if (record.endpoint === bridge) return
            }
            await Bun.sleep(250)
        }
        throw new Error(`the client did not open its bridge within ${BOOT_MS / 1000}s`)
    }

    function own(proc: ReturnType<ProcessesT["spawn"]>, label: string): void {
        procs.push(proc)
        void proc.exited.then(code => {
            if (state === "failed" || state === "stopped") return
            move("failed", `${label} exited (code ${code})`)
        })
    }

    /**
     * Load this body's null sink, idempotently.
     *
     * Named after the slot so a restarted body reuses its own rather than
     * accumulating one per boot. Already-loaded is success: `pactl` fails when
     * the name is taken, and that is precisely the state we want.
     */
    async function openSink(): Promise<void> {
        const existing = await pactl(["list", "short", "sinks"])
        if (existing.includes(sink)) return

        const loaded = await pactl([
            "load-module", "module-null-sink",
            `sink_name=${sink}`,
            `sink_properties=device.description=${sink}`,
        ])
        if (loaded.trim() === "") {
            throw err("WORLD_BODY_FAILED", {
                detail: `${opts.id} could not create its audio sink — is PipeWire or PulseAudio running?`,
                context: { body: opts.id, sink: sink },
            })
        }
    }

    /**
     * Keep this client's audio parked on this body's sink.
     *
     * A watcher rather than a one-off, for two reasons. FAudio opens its stream
     * LAZILY — nothing exists to move until the first sound plays, which may be
     * minutes after boot — and stream-restore re-applies its remembered sink
     * whenever a stream is recreated. One move at startup would find nothing
     * and then be undone.
     *
     * Matched on the client's COMMAND LINE, which carries this body's own save
     * directory. Every candidate identifier was worse:
     *
     *   the application name — every body is a `dotnet`, so it would drag one
     *     body's ears onto another's sink, or hijack the person's own apps.
     *   the spawned pid — processes start through `setsid`, which forks, so
     *     what the daemon holds is not the process that opens the stream.
     *   the process group — setsid's child becomes its own group leader, so the
     *     group is not shared with anything the daemon recorded either.
     *
     * `-tmlsavedirectory .../bodies/<id>/tml` is on the command line of exactly
     * one process on the machine, and it is this body's client.
     */
    function bindAudio(): void {
        const timer = setInterval(() => {
            if (state === "stopped" || state === "failed") {
                clearInterval(timer)
                return
            }
            void park().catch(() => {})
        }, AUDIO_BIND_MS)

        // `unref` so a body waiting on nothing else cannot hold the daemon open.
        timer.unref?.()
        audioBinder = timer
    }

    /** Move every stream belonging to this body's client onto its sink. */
    async function park(): Promise<void> {
        const inputs = await pactl(["list", "sink-inputs"])
        if (inputs === "") return

        const ours = await pactl(["list", "short", "sinks"])
        const id = ours.split("\n").find(line => line.split("\t")[1] === sink)?.split("\t")[0]
        if (!id) return

        for (const block of inputs.split("Sink Input #").slice(1)) {
            const input = block.slice(0, block.indexOf("\n")).trim()
            const owner = /application\.process\.id = "(\d+)"/.exec(block)?.[1]
            const on = /Sink:\s*(\d+)/.exec(block)?.[1]
            if (!input || !owner || on === id) continue
            if (!isOurs(Number(owner))) continue
            await pactl(["move-sink-input", input, sink])
        }
    }

    /**
     * Is this process this body's own client?
     *
     * Read from /proc rather than shelled out to: this runs every couple of
     * seconds per body, and `ps` would be a process spawn to answer a question
     * a file already holds. Arguments are NUL-separated, so the save directory
     * is one whole argument and cannot match a prefix of another body's.
     */
    function isOurs(pid: number): boolean {
        try {
            const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf-8")
            return cmdline.split("\0").includes(saveDir)
        } catch {
            // The process exited between listing the stream and reading it. Not
            // an error: the stream is about to disappear too.
            return false
        }
    }

    /** Unload it. Best effort: a machine without pactl never had one to leak. */
    async function closeSink(): Promise<void> {
        const modules = await pactl(["list", "short", "modules"])
        for (const line of modules.split("\n")) {
            if (!line.includes(`sink_name=${sink}`)) continue
            const id = line.split(/\s+/)[0]
            if (id) await pactl(["unload-module", id])
        }
    }

    /** Stdout, or an empty string when the command failed — the caller decides what that means. */
    async function pactl(args: string[]): Promise<string> {
        const proc = Bun.spawn(["pactl", ...args], { stdout: "pipe", stderr: "pipe" })
        const out = await new Response(proc.stdout).text()
        await proc.exited
        return proc.exitCode === 0 ? out : ""
    }

    return {
        get id(): string { return opts.id },
        get state(): BodyState { return state },
        get character(): string | null { return character },
        get bridge(): string { return bridge },
        get frames(): string { return frames },
        get audio(): string { return audio },

        info(lease: { id: string; agent: string } | null): BodyInfo {
            return {
                id: opts.id,
                state: state,
                display: display,
                bridge: bridge,
                frames: frames,
                audio: audio,
                character: character,
                lease: lease?.id ?? null,
                agent: lease?.agent ?? null,
                error: error,
                startedAt: startedAt,
            }
        },

        /** Boot to the menu. Resolves `ready`; on any failure the body is `failed` and this throws. */
        async boot(): Promise<void> {
            try {
                await rm(dir, { recursive: true, force: true })
                await Promise.all([
                    mkdir(join(saveDir, "Players"), { recursive: true }),
                    mkdir(join(saveDir, "Mods"), { recursive: true }),
                    mkdir(frames, { recursive: true }),
                    mkdir(audio, { recursive: true }),
                ])
                await copyFile(install.lab.stagedMod, join(saveDir, "Mods", "AxonT.tmod"))
                await copyFile(join(install.lab.mods, "enabled.json"), join(saveDir, "Mods", "enabled.json"))
                const [width, height] = RESOLUTION.split("x").map(Number) as [number, number]
                await Bun.write(join(saveDir, "config.json"), JSON.stringify(clientConfig({ width: width, height: height, seen: install.seenVersions() }), null, 2))

                // Virtual speakers before the client, for the same reason the
                // virtual display comes first: SDL binds its audio device at
                // startup and will not find a sink that does not exist yet.
                await openSink()

                const xvfb = processes.spawn({
                    label: `${opts.id}:display`,
                    cmd: ["Xvfb", display, "-screen", "0", `${RESOLUTION}x24`, "-nolisten", "tcp"],
                    stdout: join(dir, "xvfb.log"),
                })
                own(xvfb, "the virtual display")
                await Bun.sleep(300)

                const since = Date.now()
                const client = processes.spawn({
                    label: `${opts.id}:client`,
                    // The game itself, not start-tModLoader.sh: that launcher
                    // backgrounds the game and exits 0 at once, so the lab saw
                    // "client exited" on every boot and killed a game that was
                    // still loading. What the launcher adds is this one variable.
                    cmd: [install.dotnet, "tModLoader.dll", "-tmlsavedirectory", saveDir],
                    cwd: install.installDir,
                    env: {
                        DOTNET_ROLL_FORWARD: "Disable",
                        DISPLAY: display,
                        // Pinned to the virtual display. Launched from inside a
                        // Wayland session, SDL prefers Wayland whenever
                        // WAYLAND_DISPLAY is set and ignores DISPLAY entirely —
                        // the client then opens a window on the person's real
                        // monitor, which is exactly what a lab body must never do.
                        WAYLAND_DISPLAY: undefined,
                        XDG_SESSION_TYPE: "x11",
                        SDL_VIDEODRIVER: "x11",
                        // Real audio, into this body's own null sink. `dummy`
                        // discarded it, which cost the organism a whole sense —
                        // and hearing is the only one that reports what is
                        // off-screen.
                        //
                        // PULSE_SINK is a REQUEST, not a guarantee: PulseAudio's
                        // stream-restore module remembers the sink an
                        // application last used and overrides it, and every
                        // client here is called "dotnet". So `bindAudio()`
                        // below moves the stream after the fact — without it a
                        // lab body plays into the machine's real speakers,
                        // which is the same failure the Wayland pinning above
                        // exists to prevent.
                        SDL_AUDIODRIVER: "pulse",
                        PULSE_SINK: sink,
                        AXONT_MANAGED_CLIENT: "1",
                        AXONT_INSTANCE_ID: opts.id,
                        AXONT_BRIDGE_PORT: String(port),
                        AXONT_DISCOVERY_PATH: discovery,
                        AXONT_STATUS_PATH: join(dir, "status.json"),
                    },
                    stdout: join(dir, "client.log"),
                })
                own(client, "the game client")

                await awaitDiscovery(since)
                control = Control({
                    endpoint: bridge,
                    onSession: next => { session = next },
                    onClose: () => { if (state !== "failed" && state !== "stopped") move("failed", "the bridge closed") },
                })
                await control.connect()
                await awaitSession("menu", BOOT_MS)

                const capture = processes.spawn({
                    label: `${opts.id}:capture`,
                    cmd: [
                        "ffmpeg", "-loglevel", "error", "-y",
                        "-f", "x11grab", "-video_size", RESOLUTION, "-framerate", String(CAPTURE_FPS), "-i", display,
                        "-f", "image2", "-qscale:v", "5", "-start_number", "0", join(frames, "frame_%08d.jpg"),
                    ],
                    stdout: join(dir, "capture.log"),
                })
                own(capture, "the frame capture")

                // Segmented wavs rather than one stream, so the reader can take
                // a settled file and delete it — the same contract the frames
                // use, and the reason neither capture needs a protocol.
                const listening = processes.spawn({
                    label: `${opts.id}:hearing`,
                    cmd: [
                        "ffmpeg", "-loglevel", "error", "-y",
                        "-f", "pulse", "-ac", String(AUDIO_CHANNELS), "-ar", String(AUDIO_RATE), "-i", `${sink}.monitor`,
                        "-f", "segment", "-segment_time", String(AUDIO_CHUNK_S), "-reset_timestamps", "1",
                        "-c:a", "pcm_s16le", "-start_number", "0", join(audio, "chunk_%08d.wav"),
                    ],
                    stdout: join(dir, "hearing.log"),
                })
                own(listening, "the audio capture")

                // After the capture, so nothing is missed between the stream
                // moving and the recorder starting.
                bindAudio()

                move("ready")
            } catch (cause) {
                // Stopped on purpose mid-boot (a restart, a trim): not a failure.
                if (state === "stopped") throw err("WORLD_BODY_FAILED", { detail: `${opts.id} was stopped while booting`, context: { body: opts.id } })
                move("failed", cause instanceof Error ? cause.message : String(cause))
                throw err("WORLD_BODY_FAILED", { detail: `${opts.id} could not boot: ${error}`, context: { body: opts.id } })
            }
        },

        /**
         * Enter the world as `name`. The character's files are copied in from
         * the agent's folder first; one that does not exist yet is created.
         */
        async join(input: { name: string; characterDir: string; host: string; port: number; password: string }): Promise<void> {
            if (state !== "ready") throw err("WORLD_BODY_FAILED", { detail: `${opts.id} is ${state}, not ready`, context: { body: opts.id } })
            move("joining")
            try {
                const copied = await copyCharacter({ from: input.characterDir, to: join(saveDir, "Players"), name: input.name })
                if (!copied) {
                    const created = await control!.command("create-player", { player: input.name }, 30_000)
                    if (!created.ok) throw new Error(`could not create character ${input.name}: ${created.error ?? "no reason given"}`)
                }
                character = input.name
                const joined = await control!.command("join", { host: input.host, port: input.port, password: input.password, player: input.name }, JOIN_MS)
                if (!joined.ok) throw new Error(`join refused: ${joined.error ?? "no reason given"}`)
                await awaitSession("in-world", JOIN_MS)
                move("embodied")
            } catch (cause) {
                character = null
                move("ready")
                throw err("WORLD_BODY_FAILED", { detail: `${opts.id} could not join as ${input.name}: ${cause instanceof Error ? cause.message : String(cause)}`, context: { body: opts.id } })
            }
        },

        /** Leave the world, and hand the character — saved on leaving — back to its owner's folder. */
        async leave(input: { characterDir: string }): Promise<void> {
            if (state !== "embodied" && state !== "joining") return
            move("leaving")
            try {
                const left = await control!.command("leave", {}, 30_000)
                if (!left.ok) throw new Error(left.error ?? "leave refused")
                await awaitSession("menu", 30_000)
                if (character) {
                    await copyCharacter({ from: join(saveDir, "Players"), to: input.characterDir, name: character })
                    // The body is handed back empty. A character left behind
                    // is found by the next lease under that name — as a stale
                    // copy, or as "already exists" when creating a new one.
                    await removeCharacter({ dir: join(saveDir, "Players"), name: character })
                }
                character = null
                move("ready")
            } catch (cause) {
                move("failed", `could not leave cleanly: ${cause instanceof Error ? cause.message : String(cause)}`)
                throw err("WORLD_BODY_FAILED", { detail: `${opts.id}: ${error}`, context: { body: opts.id } })
            }
        },

            /** Drop all but the newest captures. The pool calls this on every sweep. */
        async prune(): Promise<void> {
            await Promise.all([
                trim(frames, ".jpg", FRAMES_KEPT),
                // More chunks than frames: they are 100ms each and tiny, and an
                // onset detector wants a little history either side of a sound.
                trim(audio, ".wav", FRAMES_KEPT),
            ])
        },

        /** Stop every process. Final: a stopped body is never started again. */
        async stop(): Promise<void> {
            if (state !== "failed") state = "stopped"
            control?.close()
            control = null
            if (audioBinder) clearInterval(audioBinder)
            audioBinder = null
            for (const proc of procs) proc.kill("SIGTERM")
            // The sink outlives the processes that used it; leaving one behind
            // per body would litter the machine's audio graph until reboot.
            await closeSink()
            await Promise.race([Promise.all(procs.map(proc => proc.exited)), Bun.sleep(5_000)])
            for (const proc of procs) proc.kill("SIGKILL")
        },
    }
}

export type BodyT = ReturnType<typeof Body>

/**
 * Copy a character's files between folders. Returns false when there is no
 * `.plr` to copy — the character does not exist yet, which is a normal first
 * embodiment rather than an error.
 */
async function copyCharacter(input: { from: string; to: string; name: string }): Promise<boolean> {
    if (!existsSync(join(input.from, `${input.name}.plr`))) return false
    await mkdir(input.to, { recursive: true })
    for (const extension of CHARACTER_FILES) {
        const source = join(input.from, `${input.name}${extension}`)
        if (existsSync(source)) await copyFile(source, join(input.to, `${input.name}${extension}`))
    }
    return true
}

/** Delete a character's files from a folder — the body's, once its owner has them back. */
async function removeCharacter(input: { dir: string; name: string }): Promise<void> {
    for (const extension of CHARACTER_FILES) {
        await rm(join(input.dir, `${input.name}${extension}`), { force: true })
    }
}
