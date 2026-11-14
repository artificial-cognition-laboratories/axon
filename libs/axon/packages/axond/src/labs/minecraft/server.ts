import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { err } from "@arcforge/err"
import type { RunningWorld } from "../types"
import type { ProcessesT } from "../processes"
import type { InstallT } from "./install"
import type { JvmT } from "./jvm"
import type { OperatorT } from "./operator"
import type { WorldsT } from "./worlds"
import { WorldConfig } from "./world-config"

export type ServerOpts = { install: InstallT; processes: ProcessesT; jvm: JvmT; operator: OperatorT; worlds: WorldsT }

/**
 * The Minecraft the lab runs, client and server alike.
 *
 * 1.21.11 rather than the newer 26.x line because AxonM has to COMPILE: 26.3
 * has no usable mappings of any kind (see the mod's gradle.properties), and a
 * lab whose bridge cannot be built is a server nobody can be embodied in.
 */
const MINECRAFT_VERSION = "1.21.11"
const LOADER_VERSION = "0.19.5"
/** What an install records about itself, so a retarget is noticed rather than assumed. */
const STAMP = "axon-server.json"
/**
 * The Java majors this Minecraft's SERVER accepts.
 *
 * Stated here rather than read from Prism, because the server is not a Prism
 * instance — the daemon installs it through Fabric's own installer. It tracks
 * MINECRAFT_VERSION above and moves with it.
 */
const JAVA_MAJORS = [21, 22, 23, 24, 25] as const
const READY_MS = 180_000
const EXIT_MS = 30_000
const LOG_LINES = 1_000

/**
 * Server — Fabric's dedicated server process and its one-machine server pack.
 *
 * `bootstrap()` downloads the launcher and writes harmless local defaults.
 * It does not accept the Mojang EULA; that is an explicit act by the person
 * who owns this machine, and `start()` refuses until it has happened.
 */
export function Server(opts: ServerOpts) {
    const install = opts.install
    const processes = opts.processes
    const jvm = opts.jvm
    const operator = opts.operator
    const worlds = opts.worlds
    const config = WorldConfig({ install: install, worlds: worlds })
    let current: (RunningWorld & { proc: ReturnType<ProcessesT["spawn"]> }) | null = null
    const log: string[] = []

    function note(line: string): void {
        log.push(line)
        if (log.length > LOG_LINES) log.splice(0, log.length - LOG_LINES)
        if (!current) return
        const joined = /: ([^ ]+) joined the game$/.exec(line)
        if (joined && !current.players.includes(joined[1]!)) current.players.push(joined[1]!)
        const left = /: ([^ ]+) left the game$/.exec(line)
        if (left) current.players = current.players.filter(name => name !== left[1])
    }

    function snapshot(): RunningWorld | null {
        if (!current) return null
        const { proc: _proc, ...world } = current
        return { ...world, players: [...world.players] }
    }

    async function eulaAccepted(): Promise<boolean> {
        const path = join(install.server, "eula.txt")
        if (!existsSync(path)) return false
        return (await readFile(path, "utf-8")).split(/\r?\n/).some(line => line.trim().toLowerCase() === "eula=true")
    }

    /**
     * Which Minecraft is installed here, or null when none is.
     *
     * Read from a stamp the install writes rather than inferred from the
     * launcher jar's presence. That file's NAME is the same for every version,
     * so a check for it answers "something is installed" while the caller is
     * asking "is 1.21.11 installed" — and after a retarget the two answers
     * differ. The result was a 26.3 server started for a 1.21.11 client, which
     * fails as a protocol mismatch at join time, nowhere near its cause.
     */
    async function installed(): Promise<string | null> {
        if (!existsSync(join(install.server, "fabric-server-launch.jar"))) return null
        const stamp = join(install.server, STAMP)
        if (!existsSync(stamp)) {
            // A launcher jar with no stamp predates this record. Its version is
            // genuinely unknown, and guessing it right is worse than
            // reinstalling — a wrong guess is the silent mismatch above.
            return null
        }
        try {
            const record = JSON.parse(await readFile(stamp, "utf-8")) as { minecraft?: unknown }
            return typeof record.minecraft === "string" ? record.minecraft : null
        } catch (cause) {
            throw err("WORLD_INSTALL_MISSING", { detail: `cannot read ${stamp} — delete it to reinstall the server`, cause: cause })
        }
    }

    async function installFabric(): Promise<void> {
        const java = await jvm.require(JAVA_MAJORS)
        await mkdir(install.server, { recursive: true })
        const metadata = await fetch("https://meta.fabricmc.net/v2/versions/installer")
        if (!metadata.ok) throw err("WORLD_INSTALL_MISSING", { detail: `could not fetch Fabric installer metadata: HTTP ${metadata.status}` })
        const releases: unknown = await metadata.json()
        if (!Array.isArray(releases) || !releases[0] || typeof releases[0] !== "object" || !("version" in releases[0]) || typeof releases[0].version !== "string") {
            throw err("WORLD_INSTALL_MISSING", { detail: "Fabric installer metadata had no current installer version" })
        }
        const version = releases[0].version
        const installer = join(install.server, `fabric-installer-${version}.jar`)
        const archive = await fetch(`https://maven.fabricmc.net/net/fabricmc/fabric-installer/${version}/fabric-installer-${version}.jar`)
        if (!archive.ok) throw err("WORLD_INSTALL_MISSING", { detail: `could not download Fabric installer ${version}: HTTP ${archive.status}` })
        await Bun.write(installer, await archive.arrayBuffer())
        const proc = Bun.spawn([java, "-jar", installer, "server", "-mcversion", MINECRAFT_VERSION, "-loader", LOADER_VERSION, "-downloadMinecraft"], {
            cwd: install.server,
            stdout: "pipe",
            stderr: "pipe",
        })
        const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()])
        if (code !== 0 || !existsSync(join(install.server, "fabric-server-launch.jar"))) {
            throw err("WORLD_INSTALL_MISSING", { detail: `Fabric server install failed:\n${`${stdout}${stderr}`.slice(-4_000)}` })
        }
        // AFTER the jar exists, never before: a stamp written first would
        // describe an install that failed, and the next boot would trust it.
        await writeFile(join(install.server, STAMP), JSON.stringify({ minecraft: MINECRAFT_VERSION, loader: LOADER_VERSION, at: new Date().toISOString() }, null, 2) + "\n")
    }

    return {
        get current(): RunningWorld | null { return snapshot() },
        log(lines = 200): string[] { return lines > 0 ? log.slice(-lines) : [] },
        async control(): Promise<{ ready: boolean; problem: string | null; state: Awaited<ReturnType<OperatorT["state"]>> | null }> {
            if (!current || current.state !== "running") return { ready: false, problem: null, state: null }
            try {
                return { ready: true, problem: null, state: await operator.state() }
            } catch (cause) {
                return { ready: false, problem: `AxonM operator unavailable: ${cause instanceof Error ? cause.message : String(cause)}`, state: null }
            }
        },
        act: operator.act,
        async problem(): Promise<string | null> {
            const missing = install.problem() ?? await jvm.problem(JAVA_MAJORS)
            if (missing) return missing
            const version = await installed()
            if (version !== MINECRAFT_VERSION) {
                return version === null
                    ? `the Fabric ${MINECRAFT_VERSION} server is not installed at ${install.server}`
                    : `the server at ${install.server} is Minecraft ${version}, but this lab runs ${MINECRAFT_VERSION} — bootstrap it again`
            }
            if (!await eulaAccepted()) return `the Minecraft EULA has not been accepted at ${join(install.server, "eula.txt")}`
            return null
        },
        async bootstrap(input: { acceptEula: boolean; name: string; port?: number; players?: number }): Promise<void> {
            if (await installed() !== MINECRAFT_VERSION) await installFabric()
            await config.write({ name: input.name, port: input.port ?? 25565, players: input.players ?? 16 })
            if (input.acceptEula) {
                await writeFile(join(install.server, "eula.txt"), "# Accepted explicitly through Axon\neula=true\n")
            }
        },
        /**
         * Starts `name`. A run starts a COPY of it instead: `level` is that folder, and `env` what the server half
         * is told about the run.
         */
        async start(input: { name: string; port: number; players: number; level?: string; env?: Record<string, string> }): Promise<RunningWorld> {
            if (current) throw err("WORLD_ALREADY_RUNNING", { detail: `${current.name} is running`, context: { world: current.name } })
            install.require()
            const version = await installed()
            if (version !== MINECRAFT_VERSION) {
                throw err("WORLD_INSTALL_MISSING", { detail: `the server at ${install.server} is ${version ?? "not installed"}, but this lab runs Minecraft ${MINECRAFT_VERSION} — bootstrap it again` })
            }
            if (!await eulaAccepted()) throw err("WORLD_INSTALL_MISSING", { detail: `the Minecraft EULA has not been accepted at ${join(install.server, "eula.txt")}` })
            await config.write(input)
            log.length = 0
            const java = await jvm.require(JAVA_MAJORS)
            const controlEnv = { ...operator.bind(input.name, input.port), ...input.env }
            let proc: ReturnType<ProcessesT["spawn"]>
            try { proc = processes.spawn({
                label: `minecraft:${input.name}`,
                cmd: [java, "-Xms1G", "-Xmx4G", "-jar", "fabric-server-launch.jar", "nogui"],
                cwd: install.server,
                env: controlEnv,
                stdout: "pipe",
                stdin: "pipe",
            }) } catch (cause) { operator.clear(); throw cause }
            current = { name: input.name, path: input.level ?? join(install.worlds, input.name), state: "starting", host: "127.0.0.1", port: input.port, password: "", players: [], pid: proc.pid, startedAt: new Date().toISOString(), observers: [], proc: proc }
            const started = current
            const ready = new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error(`did not finish booting within ${READY_MS / 1000}s`)), READY_MS)
                let gameReady = false
                let operatorReady = false
                void pump(proc.stdout as ReadableStream<Uint8Array>, line => {
                    note(line)
                    if (/Done \(.+\)! For help, type "help"/i.test(line)) gameReady = true
                    if (line.includes("AxonM operator control listening")) operatorReady = true
                    if (gameReady && operatorReady) { clearTimeout(timer); resolve() }
                }).catch(cause => { clearTimeout(timer); note(`[lab] stdout failed: ${String(cause)}`); proc.kill("SIGKILL"); reject(cause) })
                void pump(proc.stderr as ReadableStream<Uint8Array>, line => note(`[stderr] ${line}`))
                    .catch(cause => { clearTimeout(timer); note(`[lab] stderr failed: ${String(cause)}`); proc.kill("SIGKILL"); reject(cause) })
                void proc.exited.then(code => { clearTimeout(timer); reject(new Error(`exited with code ${code} before becoming ready`)) })
            })
            void proc.exited.then(() => { if (current === started) { current = null; operator.clear() } })
            try {
                await ready
                await operator.state()
            } catch (cause) {
                if (current === started) current = null
                operator.clear()
                proc.kill("SIGKILL")
                throw err("WORLD_START_FAILED", { detail: `${input.name}: ${cause instanceof Error ? cause.message : String(cause)}\n${log.slice(-30).join("\n")}`, context: { world: input.name } })
            }
            started.state = "running"
            return snapshot()!
        },
        async stop(): Promise<void> {
            const running = current
            if (!running) return
            running.state = "stopping"
            const stdin = running.proc.stdin as { write(data: string): void; flush?(): void } | undefined
            if (!stdin) throw new Error("Minecraft server has no control stdin")
            stdin.write("stop\n")
            stdin.flush?.()
            const exited = await Promise.race([running.proc.exited.then(() => true), Bun.sleep(EXIT_MS).then(() => false)])
            if (!exited) {
                note(`[lab] Minecraft ignored stop for ${EXIT_MS / 1000}s — killed`)
                running.proc.kill("SIGKILL")
                await running.proc.exited
            }
            if (current === running) current = null
            operator.clear()
        },
    }
}

export type ServerT = ReturnType<typeof Server>

async function pump(stream: ReadableStream<Uint8Array>, each: (line: string) => void): Promise<void> {
    const decoder = new TextDecoder()
    let carry = ""
    for await (const chunk of stream) {
        carry += decoder.decode(chunk, { stream: true })
        const lines = carry.split(/\r?\n/)
        carry = lines.pop() ?? ""
        for (const line of lines) if (line.trim()) each(line.trim())
    }
    if (carry.trim()) each(carry.trim())
}
