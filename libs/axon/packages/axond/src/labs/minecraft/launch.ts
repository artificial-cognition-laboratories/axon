import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { err } from "@arcforge/err"

export type LaunchOpts = {
    /** Prism's data directory — where its `libraries/`, `meta/` and `instances/` live. */
    prism?: string
    /** The provisioned instance a body's install is derived from. */
    template?: string
}

/** Everything a body needs to start a JVM. */
export type LaunchManifest = {
    /** Every jar, libraries first and the game jar last. */
    classpath: string[]
    /** Fabric's client entrypoint when the instance has the loader; vanilla's otherwise. */
    mainClass: string
    minecraft: string
    /** Prism's shared asset root, and which index inside it this version reads. */
    assets: string
    assetIndex: string
    /** Java majors this Minecraft accepts, so a wrong JDK fails by name. */
    javaMajors: number[]
}

/** Maven coordinate → the path Prism stores that artifact at. */
type Library = { name?: unknown; rules?: unknown }
type Component = { uid: string; version: string }

/** Prism's own OS name for this platform, as its library rules spell it. */
const OS = "linux"

/**
 * Launch — the JVM invocation a managed Minecraft body is started with.
 *
 * ── Why Prism provisions and the daemon launches ────────────────────────────
 *
 * Prism solved a real problem well: downloading Minecraft's libraries, natives,
 * asset index and a Fabric loader that matches. Reimplementing that downloader
 * would be a lot of code to arrive at the same files.
 *
 * But Prism must not be in the RUN path. It is a Qt GUI application, so it
 * wants a display of its own, and it starts the game through its own launcher
 * jar (`org.prismlauncher.EntryPoint` → `StandardLauncher` → `KnotClient`) —
 * another process between the daemon and the thing it supervises. That is
 * precisely the trap Terraria's body documents: `start-tModLoader.sh`
 * backgrounded the game and exited 0, so the lab saw "client exited" on every
 * boot and killed a game that was still loading.
 *
 * It is also the split the server half of this lab already uses: `Server`
 * shells the official Fabric INSTALLER once, then spawns `java` directly.
 *
 * ── Why the classpath is read from component metadata ───────────────────────
 *
 * The first version of this walked `libraries/` and took every jar it found,
 * filtering only the Minecraft client by version. That is wrong the moment
 * Prism holds two instances, and it was: with 26.3 and 1.21.11 both
 * provisioned it produced 124 jars including BOTH LWJGL 3.3.3 and 3.4.3, and
 * `intermediary-26.3` on a 1.21.11 classpath. None of that is an error the JVM
 * reports — it is a game behaving like a version nobody selected.
 *
 * So the classpath is built the way Prism builds it: the instance names its
 * components, each component's `meta/<uid>/<version>.json` names exactly its
 * libraries, and every artifact resolves from its Maven coordinate. A library
 * this platform is not allowed is left out rather than shipped inert.
 */
export function Launch(opts: LaunchOpts) {
    const prism = opts.prism ?? process.env.AXON_MINECRAFT_PRISM ?? join(homedir(), ".local", "share", "PrismLauncher")
    const template = opts.template ?? process.env.AXON_MINECRAFT_TEMPLATE ?? "1.21.11"
    const instance = join(prism, "instances", template)
    const libraries = join(prism, "libraries")

    function read(path: string, what: string): Record<string, unknown> {
        try {
            return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>
        } catch (cause) {
            throw err("WORLD_INSTALL_MISSING", { detail: `cannot read ${what} at ${path}`, cause: cause })
        }
    }

    function components(): Component[] {
        const pack = read(join(instance, "mmc-pack.json"), `the ${template} instance`)
        const listed = pack.components
        if (!Array.isArray(listed)) throw err("WORLD_INSTALL_MISSING", { detail: `the ${template} instance names no components` })
        return listed.map(entry => {
            const uid = (entry as Component).uid
            const version = (entry as Component).version
            if (typeof uid !== "string" || typeof version !== "string") {
                throw err("WORLD_INSTALL_MISSING", { detail: `the ${template} instance has a component with no uid or version` })
            }
            return { uid: uid, version: version }
        })
    }

    /**
     * Is this library allowed here?
     *
     * Prism's rules are last-match-wins over an ordered list, with a missing
     * `os` meaning "any". Honoured rather than ignored because the natives are
     * published per platform: taking them all would put macOS and Windows jars
     * on a Linux classpath.
     */
    function allowed(rules: unknown): boolean {
        if (!Array.isArray(rules) || rules.length === 0) return true
        let verdict = false
        for (const rule of rules as Array<{ action?: unknown; os?: { name?: unknown } }>) {
            const name = rule.os?.name
            if (typeof name === "string" && name !== OS) continue
            verdict = rule.action === "allow"
        }
        return verdict
    }

    /**
     * `group:artifact:version[:classifier]` → the path Prism stores it at.
     *
     * The classifier is the fourth part and it is not optional in practice:
     * Minecraft's per-platform natives are published as classifiers of one
     * artifact (`io.netty:netty-transport-native-epoll:4.2.7.Final:linux-x86_64`),
     * and ignoring it resolves to a bare jar that was never downloaded. That
     * cost exactly one jar off the classpath, which is the kind of gap a
     * `NoClassDefFoundError` deep in startup reports as something else.
     */
    function artifact(coordinate: string): string {
        const parts = coordinate.split(":")
        if (parts.length < 3) throw err("WORLD_INSTALL_MISSING", { detail: `"${coordinate}" is not a Maven coordinate` })
        const [group, name, version, classifier] = parts as [string, string, string, string | undefined]
        const file = classifier ? `${name}-${version}-${classifier}.jar` : `${name}-${version}.jar`
        return join(libraries, ...group.split("."), name, version, file)
    }

    function jarsOf(meta: Record<string, unknown>): string[] {
        const listed = Array.isArray(meta.libraries) ? (meta.libraries as Library[]) : []
        const found: string[] = []
        for (const library of listed) {
            if (typeof library.name !== "string" || !allowed(library.rules)) continue
            found.push(artifact(library.name))
        }
        return found
    }

    return {
        prism: prism,
        template: template,
        instance: instance,
        /** The instance's own `minecraft/` folder — what a body's game directory is copied from. */
        gameDir: join(instance, "minecraft"),

        problem(): string | null {
            if (!existsSync(instance)) return `no provisioned Minecraft instance at ${instance} — create it in Prism, add Fabric Loader, launch it once`
            if (!existsSync(libraries)) return `Prism has no libraries at ${libraries} — launch the instance once so it downloads them`
            const uids = components().map(entry => entry.uid)
            if (!uids.includes("net.fabricmc.fabric-loader")) {
                return `the ${template} Prism instance has no Fabric Loader — add it in Prism and launch once, or AxonM cannot load`
            }
            if (!uids.includes("net.fabricmc.intermediary")) {
                return `the ${template} Prism instance has no intermediary mappings — launch it once in Prism so they download`
            }
            return null
        },

        require(): void {
            const missing = this.problem()
            if (missing) throw err("WORLD_INSTALL_MISSING", { detail: missing })
        },

        components: components,

        /** The version of one component, or null when the instance does not have it. */
        component(uid: string): string | null {
            return components().find(entry => entry.uid === uid)?.version ?? null
        },

        /**
         * The whole launch manifest for this instance.
         *
         * Components are read in the order the instance lists them, which is
         * the order Prism resolves them: a later component's `mainClass` wins,
         * so Fabric Loader's `KnotClient` replaces vanilla's `Main` exactly as
         * it does under Prism.
         */
        manifest(): LaunchManifest {
            const classpath: string[] = []
            let mainClass: string | null = null
            let minecraft: string | null = null
            let assetIndex: string | null = null
            let javaMajors: number[] = []
            let game: string | null = null

            for (const component of components()) {
                const path = join(prism, "meta", component.uid, `${component.version}.json`)
                if (!existsSync(path)) {
                    throw err("WORLD_INSTALL_MISSING", { detail: `Prism has no metadata for ${component.uid} ${component.version} — launch the ${template} instance once` })
                }
                const meta = read(path, `${component.uid} ${component.version}`)

                for (const jar of jarsOf(meta)) if (!classpath.includes(jar)) classpath.push(jar)
                if (typeof meta.mainClass === "string") mainClass = meta.mainClass

                if (component.uid === "net.minecraft") {
                    minecraft = component.version
                    const index = (meta.assetIndex as { id?: unknown } | undefined)?.id
                    if (typeof index !== "string" && typeof index !== "number") {
                        throw err("WORLD_INSTALL_MISSING", { detail: `Minecraft ${component.version} metadata names no asset index` })
                    }
                    assetIndex = String(index)
                    const majors = meta.compatibleJavaMajors
                    if (Array.isArray(majors)) javaMajors = majors.filter((entry): entry is number => typeof entry === "number")
                    // The game jar is not in `libraries`; it is the component's
                    // own `mainJar`, and it goes LAST — Fabric's loader reads
                    // the game off the end of the classpath, and a vanilla class
                    // winning over a library's patched one is a class-loading
                    // bug nobody can read from a stack trace.
                    game = artifact(`com.mojang:minecraft:${component.version}`).replace(/\.jar$/, "-client.jar")
                }
            }

            if (!minecraft || !assetIndex) throw err("WORLD_INSTALL_MISSING", { detail: `the ${template} instance has no Minecraft component` })
            if (!mainClass) throw err("WORLD_INSTALL_MISSING", { detail: `no component of ${template} declares a main class` })
            if (!game || !existsSync(game)) {
                throw err("WORLD_INSTALL_MISSING", { detail: `Prism has no Minecraft ${minecraft} client jar at ${game} — launch the ${template} instance once` })
            }

            return {
                classpath: [...classpath, game],
                mainClass: mainClass,
                minecraft: minecraft,
                assets: join(prism, "assets"),
                assetIndex: assetIndex,
                javaMajors: javaMajors,
            }
        },
    }
}

export type LaunchT = ReturnType<typeof Launch>
