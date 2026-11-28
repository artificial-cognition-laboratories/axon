import { mkdir } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { createServer } from "node:net"
import { err } from "@arcforge/err"
import type { InstallT } from "./install"
import type { ProcessesT } from "../processes"
import type { LabAction, LabActionResult, RunningWorld } from "../types"

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
    let labToken: string | null = null
    let labPort: number | null = null
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

    /** The server mod needs its port before launch; let the OS choose one. */
    async function allocatePort(): Promise<number> {
        const socket = createServer()
        try {
            await new Promise<void>((resolve, reject) => {
                socket.once("error", reject)
                socket.listen(0, "127.0.0.1", resolve)
            })
            const address = socket.address()
            if (!address || typeof address === "string") throw new Error("Could not allocate a lab control port.")
            return address.port
        } finally {
            if (socket.listening) await new Promise<void>((resolve, reject) => socket.close(error => error ? reject(error) : resolve()))
        }
    }

    return {
        get current(): RunningWorld | null {
            return snapshot()
        },

        /** The server's recent output, oldest first. */
        log(lines = 200): string[] {
            return lines > 0 ? log.slice(-lines) : []
        },

        async control(): Promise<{ ready: boolean; problem: string | null }> {
            if (!current || current.state !== "running") return { ready: false, problem: null }
            if (!labToken || !labPort) return { ready: false, problem: "Lab control endpoint was not configured." }
            try {
                const response = await fetch(`http://127.0.0.1:${labPort}/health`, {
                    headers: { authorization: `Bearer ${labToken}` },
                    signal: AbortSignal.timeout(1_000),
                })
                if (!response.ok) return { ready: false, problem: `Lab control returned HTTP ${response.status}.` }
                const answer = await response.json() as { ready?: boolean }
                return answer.ready === true
                    ? { ready: true, problem: null }
                    : { ready: false, problem: "Lab control gave an invalid health response." }
            } catch (cause) {
                return { ready: false, problem: `AxonT server control is unavailable: ${cause instanceof Error ? cause.message : String(cause)}. Restart the world to load the rebuilt mod.` }
            }
        },

        async act(action: LabAction): Promise<LabActionResult> {
            const running = current
            const token = labToken
            const port = labPort
            if (!running || running.state !== "running" || action.world !== running.name || !token || !port)
                throw err("WORLD_NOT_RUNNING", { detail: `requested ${action.world}; current world is ${running?.name ?? "none"}` })
            const controller = new AbortController()
            const timer = setTimeout(() => controller.abort(), 10_000)
            try {
                const response = await fetch(`http://127.0.0.1:${port}/action`, {
                    method: "POST",
                    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
                    body: JSON.stringify({
                        Kind: action.kind,
                        Player: "player" in action ? action.player : null,
                        Entity: "entity" in action ? action.entity : null,
                        X: "x" in action ? action.x : 0,
                        Y: "y" in action ? action.y : 0,
                        Value: "value" in action ? action.value : 0,
                    }),
                    signal: controller.signal,
                })
                const answer = await response.json() as { ok: boolean; result?: string; error?: string }
                if (!response.ok || !answer.ok || !answer.result) throw new Error(answer.error ?? `lab control returned HTTP ${response.status}`)
                if (current !== running) throw new Error("The world changed while the lab action ran.")
                return { at: Date.now(), world: running.name, action: action, result: answer.result }
            } finally { clearTimeout(timer) }
        },

        async start(input: { name: string; path: string; port: number; players: number }): Promise<RunningWorld> {
            if (current) throw err("WORLD_ALREADY_RUNNING", { detail: `${current.name} is running`, context: { world: current.name } })
            await mkdir(install.lab.serverSave, { recursive: true })
            log.length = 0

            labPort = await allocatePort()
            labToken = randomUUID()
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
                env: { AXONT_LAB_PORT: String(labPort), AXONT_LAB_TOKEN: labToken },
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
                observers: [],
                attached: false,
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
                if (current === started) { current = null; labToken = null; labPort = null }
            })

            try {
                await ready
            } catch (cause) {
                if (current === started) { current = null; labToken = null; labPort = null }
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
            if (current === running) { current = null; labToken = null; labPort = null }
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
