import { mkdir } from "node:fs/promises"
import { err } from "@arcforge/err"
import type { InstallT } from "./install"
import type { ProcessesT } from "./processes"
import type { RunningWorld } from "./types"

export type ServerOpts = {
    install: InstallT
    processes: ProcessesT
}

/** How long a world may take to load and start listening. Large worlds are slow. */
const READY_MS = 180_000
/** How long `exit` gets to save the world before the process is killed. */
const EXIT_MS = 30_000
/** Server output kept for the Logs tab. */
const LOG_LINES = 1_000

/**
 * Server — one tModLoader dedicated server, hosting one world.
 *
 * Launched directly rather than through the game's "Host & Play", which runs
 * the server as a child of a graphical client: that is why a person's own
 * client had to be open for an agent to join. A dedicated server needs nobody.
 *
 * Ready means LISTENING, read from the server's own output — not "the process
 * exists". A world loads for tens of seconds before it accepts anyone, and a
 * body dialling in during that window fails in a way that looks like a
 * network fault.
 *
 * Players are tracked from the same output (`X has joined.`), which is what
 * the server itself knows and says; nothing is inferred.
 */
export function Server(opts: ServerOpts) {
    const { install, processes } = opts
    let current: (RunningWorld & { proc: ReturnType<ProcessesT["spawn"]> }) | null = null
    const log: string[] = []

    function note(line: string): void {
        log.push(line)
        if (log.length > LOG_LINES) log.splice(0, log.length - LOG_LINES)
        if (!current) return
        const joined = /^(.+) has joined\.$/.exec(line)
        if (joined && !current.players.includes(joined[1]!)) current.players.push(joined[1]!)
        const left = /^(.+) has left\.$/.exec(line)
        if (left) current.players = current.players.filter(name => name !== left[1])
    }

    /** The running world as data — the process handle is this leaf's alone. */
    function snapshot(): RunningWorld | null {
        if (!current) return null
        const { proc: _proc, ...world } = current
        return { ...world, players: [...world.players] }
    }

    return {
        get current(): RunningWorld | null {
            return snapshot()
        },

        /** The server's recent output, oldest first. */
        log(lines = 200): string[] {
            return lines > 0 ? log.slice(-lines) : []
        },

        async start(input: { name: string; path: string; port: number; players: number }): Promise<RunningWorld> {
            if (current) throw err("WORLD_ALREADY_RUNNING", { detail: `${current.name} is running`, context: { world: current.name } })
            await mkdir(install.lab.serverSave, { recursive: true })
            log.length = 0

            const proc = processes.spawn({
                label: `server:${input.name}`,
                cmd: [
                    install.dotnet, "tModLoader.dll", "-server",
                    "-world", input.path,
                    "-port", String(input.port),
                    "-players", String(input.players),
                    // Empty on purpose: a password-protected lab is a later decision.
                    "-pass", "",
                    "-modpath", install.lab.mods,
                    "-tmlsavedirectory", install.lab.serverSave,
                    "-lang", "1",
                ],
                cwd: install.installDir,
                stdout: "pipe",
                stdin: "pipe",
            })
            current = {
                name: input.name,
                path: input.path,
                state: "starting",
                host: "127.0.0.1",
                port: input.port,
                password: "",
                players: [],
                pid: proc.pid,
                startedAt: new Date().toISOString(),
                proc: proc,
            }
            const started = current

            const ready = new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error(`did not start listening within ${READY_MS / 1000}s`)), READY_MS)
                const watch = (line: string) => {
                    if (/Listening on port|Server started/i.test(line)) {
                        clearTimeout(timer)
                        resolve()
                    }
                }
                void pump(proc.stdout as ReadableStream<Uint8Array>, line => { note(line); watch(line) })
                void pump(proc.stderr as ReadableStream<Uint8Array>, line => note(`[stderr] ${line}`))
                void proc.exited.then(code => {
                    clearTimeout(timer)
                    reject(new Error(`exited with code ${code} before listening`))
                })
            })

            void proc.exited.then(() => {
                if (current === started) current = null
            })

            try {
                await ready
            } catch (cause) {
                if (current === started) current = null
                proc.kill("SIGKILL")
                throw err("WORLD_START_FAILED", {
                    detail: `${input.name}: ${cause instanceof Error ? cause.message : String(cause)}\n${log.slice(-30).join("\n")}`,
                    context: { world: input.name },
                })
            }
            started.state = "running"
            return snapshot()!
        },

        /** Save and stop. `exit` saves the world; a server that ignores it is killed. */
        async stop(): Promise<void> {
            const running = current
            if (!running) return
            running.state = "stopping"
            const stdin = running.proc.stdin as { write(data: string): void; flush?(): void } | undefined
            stdin?.write("exit\n")
            stdin?.flush?.()
            const exited = await Promise.race([running.proc.exited.then(() => true), Bun.sleep(EXIT_MS).then(() => false)])
            if (!exited) {
                note(`[lab] server ignored exit for ${EXIT_MS / 1000}s — killed`)
                running.proc.kill("SIGKILL")
                await running.proc.exited
            }
            if (current === running) current = null
        },
    }
}

export type ServerT = ReturnType<typeof Server>

/** Feed a byte stream to `each`, one line at a time. */
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
