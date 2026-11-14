import { join } from "node:path"
import type { ProcessesT } from "../../processes"
import { offlineUuid } from "../identity"
import type { JvmT } from "../jvm"
import type { LaunchT } from "../launch"
import type { ModT } from "../mod"
import type { StudioOpened, StudioPlace } from "../../types"
import { AuthorMods } from "./mods"
import { Profile } from "./profile"
import { Stream } from "./stream"

const NAME = "AxonStudio"

type State = "stopped" | "starting" | "running" | "failed"

/** The desktop's own settings, restored over whatever the stream last set. */
const DESKTOP = {
    pauseOnLostFocus: "true", overrideWidth: "0", overrideHeight: "0",
    maxFps: "120", enableVsync: "true", rawMouseInput: "true", soundDevice: "\"\"", skipMultiplayerWarning: "true",
}

/**
 * Studio — the authoring client: a person's Minecraft with AxonM and the
 * building mods, whose Singleplayer worlds are the lab's. One at a time, in
 * one of two places.
 */
export function Studio(opts: { root: string; processes: ProcessesT; launch: LaunchT; jvm: JvmT; mod: ModT; stagedMod: string; worlds: string }) {
    const dir = join(opts.root, "studio")
    const mods = AuthorMods({ cache: join(opts.root, "author-mods") })
    const profile = Profile({ dir: dir, template: opts.launch.gameDir, stagedMod: opts.stagedMod, worlds: opts.worlds, mods: mods })
    let state: State = "stopped"
    let place: StudioPlace | null = null
    let failure: string | null = null
    let starting: Promise<StudioOpened> | null = null
    const processes: Array<ReturnType<ProcessesT["spawn"]>> = []

    function own(process: ReturnType<ProcessesT["spawn"]>, label: string): void {
        if (state !== "starting") {
            process.kill("SIGTERM")
            throw new Error(failure ?? "Studio launch was cancelled")
        }
        processes.push(process)
        void process.exited.then(code => {
            if (state === "stopped" || state === "failed") return
            // A person closing the game on their desktop is the Studio stopping, not failing.
            if (place === "desktop" && label === "Studio client" && code === 0) {
                void stop()
                return
            }
            state = "failed"
            failure = `${label} exited with code ${code} (see ${join(dir, "client.log")})`
        })
    }

    const stream = Stream({
        dir: dir,
        root: opts.root,
        gameDir: profile.gameDir,
        processes: opts.processes,
        own: own,
        live: () => state === "starting" || state === "running",
        fail: reason => { state = "failed"; failure = reason },
    })

    function opened(): StudioOpened {
        if (place === "fleet") return { on: "fleet", url: stream.url() }
        return { on: "desktop" }
    }

    /** The desktop the client opens on: the daemon's own, which must have one. */
    function desktop(): Record<string, string | undefined> {
        if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
            throw new Error("The Axon daemon has no desktop to open Minecraft on (neither DISPLAY nor WAYLAND_DISPLAY is set); restart it from your desktop session")
        }
        return {}
    }

    async function launch(on: StudioPlace): Promise<StudioOpened> {
        opts.launch.require()
        const manifest = opts.launch.manifest()
        const java = await opts.jvm.require(manifest.javaMajors)
        await opts.mod.stage()
        await profile.prepare(on === "fleet" ? stream.settings : DESKTOP)
        if (state !== "starting") throw new Error("Studio launch was cancelled")
        const env = on === "fleet" ? await stream.open() : desktop()
        if (state !== "starting") throw new Error("Studio launch was cancelled")
        own(opts.processes.spawn({
            label: "minecraft-studio:client",
            cmd: [
                java, "-Xms512M", "-Xmx2G", "-cp", manifest.classpath.join(":"), manifest.mainClass,
                "--username", NAME, "--uuid", offlineUuid(NAME), "--accessToken", "0",
                "--version", manifest.minecraft, "--versionType", "release", "--gameDir", profile.gameDir,
                "--assetsDir", manifest.assets, "--assetIndex", manifest.assetIndex,
            ],
            cwd: profile.gameDir,
            env: env,
            stdout: join(dir, "client.log"),
        }), "Studio client")
        if (on === "fleet") await stream.attach()
        state = "running"
        return opened()
    }

    async function stop(): Promise<void> {
        if (state === "stopped" && processes.length === 0) return
        state = "stopped"
        const was = place
        place = null
        for (const process of processes) process.kill("SIGTERM")
        await Promise.race([Promise.all(processes.map(process => process.exited)), Bun.sleep(5000)])
        for (const process of processes) process.kill("SIGKILL")
        processes.length = 0
        if (was === "fleet") await stream.close()
    }

    return {
        status(): { state: State; on: StudioPlace | null; failure: string | null } {
            return { state: state, on: place, failure: failure }
        },
        /** Opens the authoring client `on` the desktop or in Fleet; the one already open, when it is there. */
        async open(input: { on: StudioPlace }): Promise<StudioOpened> {
            // Checked before any state moves: a caller from before `on` existed must be refused, not leave Studio "starting" for ever.
            if (input?.on !== "desktop" && input?.on !== "fleet") throw new Error(`Studio opens on "desktop" or "fleet", not ${JSON.stringify(input?.on)}`)
            if (state === "running") {
                if (place !== input.on) throw new Error(`Studio is already open on the ${place}; stop it before opening it on the ${input.on}`)
                return opened()
            }
            if (starting) return await starting
            if (state === "failed") await stop()
            if (state !== "stopped") throw new Error(`Studio is ${state}; stop it before opening`)
            state = "starting"
            place = input.on
            failure = null
            starting = (async () => {
                try {
                    return await launch(input.on)
                } catch (cause) {
                    failure = cause instanceof Error ? cause.message : String(cause)
                    await stop()
                    state = "failed"
                    throw new Error(`Minecraft Studio could not open: ${failure}`, { cause: cause })
                } finally {
                    starting = null
                }
            })()
            return await starting
        },
        stop: stop,
    }
}

export type StudioT = ReturnType<typeof Studio>
