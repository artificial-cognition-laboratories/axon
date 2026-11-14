import { existsSync } from "node:fs"
import { copyFile, mkdir, readFile, rm, stat } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { err } from "@arcforge/err"
import { Control, Display, Hearing, Rest, commandLineHas, type ControlT } from "../body/index"
import type { InstallT } from "./install"
import type { ProcessesT } from "../processes"
import type { BodyHandle } from "../body/index"
import type { BodyInfo, BodyState, RunningWorld } from "../types"

export type BodyOpts = {
    id: string
    /** Distinct per body: picks its display and bridge port. */
    slot: number
    install: InstallT
    processes: ProcessesT
}

/** The client renders here. */
const RESOLUTION = "1280x720"

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
 * Audio chunks kept on disk. Capture runs whether or not an agent is inside,
 * and an agent consumes and deletes what it reads — so an unleased body would
 * otherwise write forever.
 */
const CHUNKS_KEPT = 48

/** Files that ARE a character: the vanilla save and tModLoader's modded data beside it. */
const CHARACTER_FILES = [".plr", ".tplr"]

/**
 * Body — one warm tModLoader client: a virtual display, the game at its menu,
 * the AxonT bridge, and captures of what it renders and hears.
 *
 * The expensive part of embodiment is booting the client, so it is done
 * BEFORE anyone needs a body, and a body outlives every agent that uses it.
 * An agent possessing one costs a server join; a brain reload costs nothing.
 *
 * The display, the client, and the audio capture are processes with one lifetime.
 * When any of them dies the body is `failed` and the pool replaces it — a
 * half-alive body (a client whose capture died) would hand an agent ears that
 * hear nothing, which is the failure this experiment cannot afford to have
 * silently.
 *
 * The SENSORY RIG is not Terraria's: a virtual screen whose memory is the body's sight, and a
 * null sink with its recorder are what any rendering client needs, and they
 * live in `labs/body/`. What stays here is what is genuinely tModLoader's —
 * its save layout, its config file, its launch argv, and what a character is.
 */
export function Body(opts: BodyOpts): BodyHandle {
    const { install, processes } = opts
    const dir = join(install.lab.bodies, opts.id)
    const saveDir = join(dir, "tml")
    const discovery = join(dir, "bridge.json")
    const port = 52_400 + opts.slot
    const bridge = `ws://127.0.0.1:${port}/bridge`

    let state: BodyState = "booting"
    let session = "detached"
    let character: string | null = null
    let error: string | null = null
    let control: ControlT | null = null
    let camera: { at: number; x: number; y: number; width: number; height: number } | null = null
    const startedAt = new Date().toISOString()
    const procs: Array<ReturnType<ProcessesT["spawn"]>> = []
    const rest = Rest()

    function move(next: BodyState, why: string | null = null): void {
        state = next
        if (next === "failed") error = why
    }

    /** Alive enough for the audio watcher to keep working. */
    function live(): boolean {
        return state !== "stopped" && state !== "failed"
    }

    const screen = Display({ slot: opts.slot, processes: processes, dir: dir, resolution: RESOLUTION })
    const hearing = Hearing({
        slot: opts.slot,
        processes: processes,
        dir: dir,
        rate: AUDIO_RATE,
        channels: AUDIO_CHANNELS,
        chunkSeconds: AUDIO_CHUNK_S,
        // They are 100ms each and tiny, and an onset detector wants a little
        // history either side of a sound.
        kept: CHUNKS_KEPT,
        // `-tmlsavedirectory .../bodies/<id>/tml` is on the command line of
        // exactly one process on the machine, and it is this body's client.
        // Every other candidate identifier was worse: the application name —
        // every body is a `dotnet`, so it would drag one body's ears onto
        // another's sink; the spawned pid — processes start through `setsid`,
        // which forks, so what the daemon holds is not the process that opens
        // the stream; the process group — setsid's child becomes its own group
        // leader, so the group is not shared with anything the daemon recorded.
        owns: pid => commandLineHas(pid, saveDir),
        onFailure: reason => move("failed", reason),
        live: live,
    })

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


    return {
        get id(): string { return opts.id },
        get state(): BodyState { return state },
        get bridge(): string { return bridge },
        get screen(): string { return screen.screen },
        get audio(): string { return hearing.dir },
        get hearing(): { sampleRate: number; channels: number } { return { sampleRate: AUDIO_RATE, channels: AUDIO_CHANNELS } },
        get resting(): boolean { return rest.resting },

        rest(): void {
            if (state !== "ready") throw err("WORLD_BODY_FAILED", { detail: `${opts.id} is ${state} — only a ready body rests`, context: { body: opts.id } })
            rest.rest()
        },

        wake(): void {
            rest.wake()
        },

        info(lease: { id: string; agent: string } | null, world: string | null): BodyInfo {
            return {
                id: opts.id,
                world: world,
                state: state,
                model: null,
                bridge: bridge,
                client: { display: screen.name, screen: screen.screen, audio: hearing.dir, resting: rest.resting },
                identity: character,
                lease: lease?.id ?? null,
                agent: lease?.agent ?? null,
                error: error,
                pids: procs.map(proc => proc.pid),
                startedAt: startedAt,
                ...(camera ? { camera: camera } : {}),
            }
        },

        /** Boot to the menu. Resolves `ready`; on any failure the body is `failed` and this throws. */
        async boot(): Promise<void> {
            try {
                await rm(dir, { recursive: true, force: true })
                await Promise.all([
                    mkdir(join(saveDir, "Players"), { recursive: true }),
                    mkdir(join(saveDir, "Mods"), { recursive: true }),
                    screen.prepare(),
                    hearing.prepare(),
                ])
                await copyFile(install.lab.stagedMod, join(saveDir, "Mods", "AxonT.tmod"))
                await copyFile(join(install.lab.mods, "enabled.json"), join(saveDir, "Mods", "enabled.json"))
                const [width, height] = RESOLUTION.split("x").map(Number) as [number, number]
                await Bun.write(join(saveDir, "config.json"), JSON.stringify(clientConfig({ width: width, height: height, seen: install.seenVersions() }), null, 2))

                // Virtual speakers before the client, for the same reason the
                // virtual display comes first: SDL binds its audio device at
                // startup and will not find a sink that does not exist yet.
                await hearing.open()

                own(screen.start(), "the virtual display")
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
                        DISPLAY: screen.name,
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
                        PULSE_SINK: hearing.sink,
                        AXONT_MANAGED_CLIENT: "1",
                        AXONT_INSTANCE_ID: opts.id,
                        AXONT_BRIDGE_PORT: String(port),
                        AXONT_DISCOVERY_PATH: discovery,
                        AXONT_STATUS_PATH: join(dir, "status.json"),
                    },
                    stdout: join(dir, "client.log"),
                })
                own(rest.hold(client), "the game client")

                await awaitDiscovery(since)
                control = Control({
                    endpoint: bridge,
                    onSession: next => {
                        session = next
                        // Put out of the world without being asked to leave — a
                        // timeout, a kick. `leave` moves to `leaving` first, so
                        // this is never the body's own doing: it is a client in
                        // a state nobody has characterised, which the pool
                        // replaces and the agent leases past.
                        if (state === "embodied" && next !== "in-world") move("failed", `put out of the world: the client went to '${next}'`)
                    },
                    onCamera: next => { camera = next },
                    onClose: () => { if (state !== "failed" && state !== "stopped") move("failed", "the bridge closed") },
                })
                await control.connect()
                await awaitSession("menu", BOOT_MS)

                own(rest.hold(hearing.start()), "the audio capture")
                hearing.bind()

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
        async join(input: { identity: string; stateDir: string; world: RunningWorld }): Promise<void> {
            if (state !== "ready") throw err("WORLD_BODY_FAILED", { detail: `${opts.id} is ${state}, not ready`, context: { body: opts.id } })
            move("joining")
            try {
                const copied = await copyCharacter({ from: input.stateDir, to: join(saveDir, "Players"), name: input.identity })
                if (!copied) {
                    const created = await control!.command("create-player", { player: input.identity }, 30_000)
                    if (!created.ok) throw new Error(`could not create character ${input.identity}: ${created.error ?? "no reason given"}`)
                }
                character = input.identity
                const joined = await control!.command("join", { host: input.world.host, port: input.world.port, password: input.world.password, player: input.identity }, JOIN_MS)
                if (!joined.ok) throw new Error(`join refused: ${joined.error ?? "no reason given"}`)
                await awaitSession("in-world", JOIN_MS)
                move("embodied")
            } catch (cause) {
                character = null
                move("ready")
                throw err("WORLD_BODY_FAILED", { detail: `${opts.id} could not join as ${input.identity}: ${cause instanceof Error ? cause.message : String(cause)}`, context: { body: opts.id } })
            }
        },

        /** Leave the world, and hand the character — saved on leaving — back to its owner's folder. */
        async leave(input: { stateDir: string }): Promise<void> {
            if (state !== "embodied" && state !== "joining") return
            move("leaving")
            try {
                const left = await control!.command("leave", {}, 30_000)
                if (!left.ok) throw new Error(left.error ?? "leave refused")
                await awaitSession("menu", 30_000)
                if (character) {
                    await copyCharacter({ from: join(saveDir, "Players"), to: input.stateDir, name: character })
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

        /** Drop all but the newest captured audio. The pool calls this on every sweep. */
        async prune(): Promise<void> {
            await hearing.prune()
        },

        /** Stop every process. Final: a stopped body is never started again. */
        async stop(): Promise<void> {
            if (state !== "failed") state = "stopped"
            control?.close()
            control = null
            camera = null
            // A frozen process cannot act on SIGTERM; wake it so it can.
            rest.wake()
            for (const proc of procs) proc.kill("SIGTERM")
            await hearing.close()
            await Promise.race([Promise.all(procs.map(proc => proc.exited)), Bun.sleep(5_000)])
            for (const proc of procs) proc.kill("SIGKILL")
            await screen.release()
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
