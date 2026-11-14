import { existsSync } from "node:fs"
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { err } from "@arcforge/err"
import { Control, Display, Hearing, Rest, commandLineHas, type BodyHandle, type ControlT } from "../body/index"
import type { BodyInfo, BodyState, RunningWorld } from "../types"
import type { ProcessesT } from "../processes"
import { offlineUuid } from "./identity"
import type { InstallT } from "./install"
import type { JvmT } from "./jvm"
import type { LaunchT } from "./launch"

export type BodyOpts = {
    id: string
    /** Distinct per body: picks its display, its sink and its bridge port. */
    slot: number
    install: InstallT
    processes: ProcessesT
    launch: LaunchT
    jvm: JvmT
}

/** The client renders here. */
const RESOLUTION = "1280x720"
/** The rate an occupant looks at; the client is asked to draw twice as often. */
const LOOK_FPS = 24

/**
 * The body's ears.
 *
 * Stereo because direction has to come from somewhere, and Minecraft's mixer
 * already pans every sound by its position relative to the listener and
 * attenuates it by distance. A stereo capture of the game's own output
 * therefore carries the cue a listener actually uses, without anyone reading
 * world state: the mixer IS the propagation model.
 *
 * 44.1kHz rather than Terraria's 22.05kHz, and the reason is HRTF. With
 * `directionalAudio` on (below), OpenAL renders through a head-related
 * transfer function, so the signal carries interaural TIME difference and the
 * spectral notches that encode ELEVATION — cues a 2D game does not have and
 * cannot fake. Those notches sit around 6–12kHz, and 22.05kHz sampling puts
 * the Nyquist limit at 11kHz, straight through the middle of them. Halving the
 * rate here would be throwing away the one thing 3D hearing buys.
 */
const AUDIO_RATE = 44_100
const AUDIO_CHANNELS = 2
/** Seconds per captured chunk: short enough to localise a sound's onset in time. */
const AUDIO_CHUNK_S = 0.1

/** A cold Minecraft client takes a while to reach its title screen. */
const BOOT_MS = 180_000
/** Server connect, handshake, chunk load. */
const JOIN_MS = 120_000
/** Audio chunks kept on disk per body. An agent consumes and deletes what it reads. */
const CHUNKS_KEPT = 48

/**
 * Bridge ports, based well clear of Terraria's range.
 *
 * Both labs can be up at once — they are different games on one machine — so
 * their bodies must not compete for a port. Terraria's bodies start at 52_400.
 */
const BRIDGE_PORT_BASE = 52_500

/** How much heap one client gets. Minecraft is the memory cost of a body, not the GPU. */
const HEAP = "2G"

/**
 * Body — one warm Minecraft client: a virtual display, the game at its title
 * screen, the AxonM bridge, and captures of what it renders and hears.
 *
 * The expensive part of embodiment is booting the client, so it is done BEFORE
 * anyone needs a body, and a body outlives every agent that uses it. An agent
 * possessing one costs a server join; a brain reload costs nothing.
 *
 * The bridge comes up at the TITLE SCREEN, before any world is joined, because
 * joining is a command that arrives over that bridge — gating the cable on
 * being in a world is a deadlock. This is why a body is warm rather than
 * committed: its identity is chosen when an agent leases it, not at launch, so
 * `--quickPlayMultiplayer` is deliberately not used.
 *
 * The SENSORY RIG is not Minecraft's: a virtual screen whose memory is the body's sight, and a
 * null sink with its recorder are what any rendering client needs, and they
 * live in `labs/body/`. What stays here is genuinely this game's — its launch
 * argv, its options file, and what an identity is without an account.
 */
export function Body(opts: BodyOpts): BodyHandle {
    const { install, processes, launch, jvm } = opts
    const dir = join(install.lab.bodies, opts.id)
    const gameDir = join(dir, "game")
    const discovery = join(dir, "bridge.json")
    const port = BRIDGE_PORT_BASE + opts.slot
    const bridge = `ws://127.0.0.1:${port}/bridge`

    let state: BodyState = "booting"
    let session = "detached"
    let identity: string | null = null
    let error: string | null = null
    let control: ControlT | null = null
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
        kept: CHUNKS_KEPT,
        // `--gameDir .../bodies/<id>/game` is on the command line of exactly one
        // process on the machine, and it is this body's client. Every other
        // identifier was worse: the application name — every body is a `java`;
        // the spawned pid — processes start through `setsid`, which forks, so
        // what the daemon holds is not the process that opens the stream.
        owns: pid => commandLineHas(pid, gameDir),
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
     * A client that cannot load a mod, or cannot open a display, says so in its
     * log and then sits there. Without this the lab waits out the whole boot
     * timeout and reports "the client did not open its bridge", which names the
     * symptom and hides the cause.
     */
    async function fatal(): Promise<string | null> {
        const log = join(dir, "client.log")
        if (!existsSync(log)) return null
        const text = await readFile(log, "utf-8")
        const line = text.split("\n").reverse().find(entry => /FATAL|Exception in thread "main"|Could not (find|load)/.test(entry))
        return line?.trim() || null
    }

    /**
     * What AxonM says about its own startup, when it got far enough to say.
     *
     * The mod records `bridge-failed` with the reason the moment it cannot
     * listen. Read here so that failure is the error the lab reports, instead of
     * three minutes of waiting followed by "the client did not open its bridge"
     * — which names the symptom and hides a cause we were already told.
     */
    async function refused(): Promise<string | null> {
        const path = join(dir, "status.json")
        if (!existsSync(path)) return null
        try {
            const record = JSON.parse(await readFile(path, "utf-8")) as { state?: string; detail?: string }
            if (record.state !== "bridge-failed") return null
            return `AxonM could not open its bridge: ${record.detail ?? "no reason given"}`
        } catch {
            // Half-written, mid-poll. The next pass reads it whole.
            return null
        }
    }

    async function awaitDiscovery(since: number): Promise<void> {
        const deadline = Date.now() + BOOT_MS
        while (Date.now() < deadline) {
            if (state === "failed" || state === "stopped") throw new Error(error ?? `body ${state} while booting`)
            const refusal = await refused()
            if (refusal) throw new Error(refusal)
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
     * The client's settings, written before its first launch.
     *
     * `pauseOnLostFocus` is the load-bearing one: a windowed client that never
     * receives focus pauses itself, so the body would sit in the world doing
     * nothing while every process looked healthy. Music is off for the same
     * reason it is off in Terraria — a soundtrack is non-diegetic, so an
     * organism hearing it would be localising something that does not exist.
     * Effects and ambience are events in the world; the score is not.
     */
    async function options(): Promise<void> {
        const [width, height] = RESOLUTION.split("x") as [string, string]
        const settings: Record<string, string> = {
            /*
             * The body's own ears, named explicitly.
             *
             * `PULSE_SINK` is NOT enough: it is a PulseAudio hint and OpenAL
             * Soft does not read it, so the client opened whatever the system
             * default happened to be — measured as
             * "OpenAL initialized on device sink-sunshine-stereo", a screen
             * streamer's sink. Every captured chunk was then perfectly formed
             * and completely silent, which is the exact failure Terraria's ears
             * document: a deaf organism whose capture looks healthy.
             *
             * Minecraft passes this straight to OpenAL as the device to open,
             * and the pulse backend names devices by their description — which
             * is why the sink is created with `device.description` set to its
             * own name. `park()` remains the guarantee for a stream that is
             * created late or moved by stream-restore; this makes the common
             * case correct from the first sound.
             */
            soundDevice: hearing.sink,
            version: "4325",
            pauseOnLostFocus: "false",
            narrator: "0",
            fullscreen: "false",
            overrideWidth: width,
            overrideHeight: height,
            // Cheaper draws, same scene. Render distance is the one that costs
            // the server too, since it decides what is sent to this client.
            renderDistance: "8",
            simulationDistance: "8",
            graphicsMode: "0",
            maxFps: String(LOOK_FPS * 2),
            enableVsync: "false",
            // Somebody DOES hear it. These would all be pointless on a dummy
            // device, but a body plays into a real null sink that is recorded.
            /*
             * HRTF, deliberately on.
             *
             * Without it the mixer only pans left/right, which is Terraria's
             * situation: a bearing and nothing else. With it, OpenAL renders
             * through a head-related transfer function and the waveform carries
             * interaural time difference and elevation — the same signal a
             * person wearing headphones gets, which is the test for whether a
             * sense is honest.
             */
            directionalAudio: "true",
            "soundCategory_master": "1.0",
            "soundCategory_music": "0.0",
            "soundCategory_record": "0.0",
            "soundCategory_ambient": "1.0",
            "soundCategory_block": "1.0",
            "soundCategory_hostile": "1.0",
            "soundCategory_neutral": "1.0",
            "soundCategory_player": "1.0",
            "soundCategory_weather": "1.0",
            /*
             * A lens that stays the lens it says it is. The body announces its
             * camera's field of view to the mind; sprinting and speed effects
             * widen it, and view bobbing sways the picture with a motion the
             * body never made — both render effects, not optics. Off, the
             * announced 70° is what every frame was taken through.
             */
            fov: "0.0",
            fovEffectScale: "0.0",
            bobView: "false",
            // Nothing to accept on first launch, and no telemetry prompt.
            skipMultiplayerWarning: "true",
            onboardAccessibility: "false",
            tutorialStep: "none",
        }
        await writeFile(join(gameDir, "options.txt"), Object.entries(settings).map(([key, value]) => `${key}:${value}`).join("\n") + "\n")
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
                identity: identity,
                lease: lease?.id ?? null,
                agent: lease?.agent ?? null,
                error: error,
                pids: procs.map(proc => proc.pid),
                startedAt: startedAt,
            }
        },

        /** Boot to the title screen. Resolves `ready`; on any failure the body is `failed` and this throws. */
        async boot(): Promise<void> {
            try {
                launch.require()
                const manifest = launch.manifest()
                // The JDK this Minecraft actually accepts, not whatever `java`
                // resolves to: Prism downloaded 21 for 1.21.11 and 25 for 26.3
                // precisely because the game is particular about it.
                const java = await jvm.require(manifest.javaMajors)

                await rm(dir, { recursive: true, force: true })
                await Promise.all([mkdir(gameDir, { recursive: true }), screen.prepare(), hearing.prepare()])

                // The template's own game folder, minus anything a previous
                // session left: a body starts from the provisioned instance, not
                // from another body's state.
                if (existsSync(launch.gameDir)) {
                    await cp(launch.gameDir, gameDir, { recursive: true, filter: source => !/\/(logs|saves|crash-reports)(\/|$)/.test(source) })
                }
                await mkdir(join(gameDir, "mods"), { recursive: true })
                if (!existsSync(install.lab.stagedMod)) {
                    throw new Error(`AxonM is not staged at ${install.lab.stagedMod} — build it and start the world`)
                }
                await cp(install.lab.stagedMod, join(gameDir, "mods", "AxonM.jar"))
                await options()

                // Virtual speakers before the client, for the same reason the
                // virtual display comes first: an audio backend binds its device
                // at startup and will not find a sink that does not exist yet.
                await hearing.open()
                own(screen.start(), "the virtual display")
                await Bun.sleep(300)

                const since = Date.now()
                const client = processes.spawn({
                    label: `${opts.id}:client`,
                    cmd: [
                        java,
                        `-Xms512M`, `-Xmx${HEAP}`,
                        "-cp", manifest.classpath.join(":"),
                        manifest.mainClass,
                        // The argument set Prism's own `minecraftArguments`
                        // template names for this version, filled in for an
                        // offline body rather than an account.
                        "--username", opts.id,
                        "--uuid", offlineUuid(opts.id),
                        "--accessToken", "0",
                        "--version", manifest.minecraft,
                        "--versionType", "release",
                        "--gameDir", gameDir,
                        "--assetsDir", manifest.assets,
                        "--assetIndex", manifest.assetIndex,
                    ],
                    cwd: gameDir,
                    env: {
                        DISPLAY: screen.name,
                        // Pinned to the virtual display. Launched from inside a
                        // Wayland session, a toolkit that prefers Wayland
                        // ignores DISPLAY entirely and opens a window on the
                        // person's real monitor — which is exactly what a lab
                        // body must never do. Measured: this client reports
                        // "Created window using SDL video driver: wayland" when
                        // WAYLAND_DISPLAY is visible to it.
                        WAYLAND_DISPLAY: undefined,
                        XDG_SESSION_TYPE: "x11",
                        SDL_VIDEODRIVER: "x11",
                        // Real audio into this body's own null sink. PULSE_SINK
                        // is a REQUEST, not a guarantee — the audio server
                        // remembers the sink an application last used, and every
                        // client here is a `java` — so `hearing.bind()` below
                        // moves the stream after the fact.
                        PULSE_SINK: hearing.sink,
                        AXONM_MANAGED_CLIENT: "1",
                        AXONM_INSTANCE_ID: opts.id,
                        AXONM_BRIDGE_PORT: String(port),
                        AXONM_DISCOVERY_PATH: discovery,
                        AXONM_STATUS_PATH: join(dir, "status.json"),
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
                    onClose: () => { if (live()) move("failed", "the bridge closed") },
                })
                await control.connect()
                await awaitSession("title", BOOT_MS)

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
         * Enter the world under this identity.
         *
         * `stateDir` is the agent's own durable folder and nothing is copied
         * into it or out of it, unlike Terraria. A Minecraft character is not a
         * client-side file: player data is NBT inside the server's world, and
         * the server owns it. Copying it out from under a running server would
         * be a corruption risk for no gain.
         */
        async join(input: { identity: string; stateDir: string; world: RunningWorld }): Promise<void> {
            if (state !== "ready") throw err("WORLD_BODY_FAILED", { detail: `${opts.id} is ${state}, not ready`, context: { body: opts.id } })
            move("joining")
            try {
                identity = input.identity
                const joined = await control!.command("join", { host: input.world.host, port: input.world.port }, JOIN_MS)
                if (!joined.ok) throw new Error(`join refused: ${joined.error ?? "no reason given"}`)
                await awaitSession("in-world", JOIN_MS)
                move("embodied")
            } catch (cause) {
                identity = null
                move("ready")
                throw err("WORLD_BODY_FAILED", { detail: `${opts.id} could not join as ${input.identity}: ${cause instanceof Error ? cause.message : String(cause)}`, context: { body: opts.id } })
            }
        },

        /** Leave the world. Nothing durable to hand back — see `join`. */
        async leave(_input: { stateDir: string }): Promise<void> {
            if (state !== "embodied" && state !== "joining") return
            move("leaving")
            try {
                const left = await control!.command("leave", {}, 30_000)
                if (!left.ok) throw new Error(left.error ?? "leave refused")
                await awaitSession("title", 30_000)
                identity = null
                move("ready")
            } catch (cause) {
                move("failed", `could not leave cleanly: ${cause instanceof Error ? cause.message : String(cause)}`)
                throw err("WORLD_BODY_FAILED", { detail: `${opts.id}: ${error}`, context: { body: opts.id } })
            }
        },

        async prune(): Promise<void> {
            await hearing.prune()
        },

        /** Stop every process. Final: a stopped body is never started again. */
        async stop(): Promise<void> {
            if (state !== "failed") state = "stopped"
            control?.close()
            control = null
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
