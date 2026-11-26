import { createSocket } from "node:dgram"
import { world as checked } from "@arcforge/body"
import { err } from "@arcforge/err"
import { world } from "@arcforge/types"
import type { ProcessesT } from "../processes"

export type ServedOpts = {
    processes: ProcessesT
    /** The `terra` executable. */
    terra: string
    /** The world's name in the player's Play list (`terra worlds`). */
    name: string
}

/** How long a server has to prepare its mods, make its universe and take players. A first start compiles its mods. */
const READY_MS = 120_000
/** How long a world has to answer a request. */
const ANSWER_MS = 10_000
/** How much of what the world said is kept for the lab's logs. */
const KEPT_LINES = 500

/** Something the world said unasked: an event, said as a line for a person. */
export type Said = { at: string; text: string }

/**
 * Served — one world, running: `terra serve --world-contract`, spoken to over
 * the world contract (axon.world/0) on its stdin and stdout. Resolves once
 * the world says it is ready, so a handle is never half-started.
 *
 * Every request carries an id, and is answered or refused by it; a refusal
 * throws with the world's own code and words. What the world says unasked —
 * that it fell behind the wall, that a mind broke the contract — is kept
 * with its stderr for the logs, and handed to `heard`. When the world ends,
 * whatever is still asked of it fails, saying how it ended.
 */
export async function Served(opts: ServedOpts & { heard: (said: Said) => void }) {
    // the port players join on: one the machine has free now
    const port = await freePort()
    const proc = opts.processes.spawn({
        label: `terraverse:${opts.name}`,
        cmd: [opts.terra, "serve", "--world", opts.name, "--world-contract", "--port", String(port)],
        stdout: "pipe",
        stdin: "pipe",
    })
    const startedAt = new Date().toISOString()
    const lines: string[] = []
    const asked = new Map<number, { resolve: (value: unknown) => void; reject: (cause: Error) => void }>()
    let next = 0
    let ended: string | null = null
    let time = 0
    let factor = 0
    let readied: (ready: world.Ready) => void = () => {}
    let unready: (cause: Error) => void = () => {}
    const ready = new Promise<world.Ready>((resolve, reject) => {
        readied = resolve
        unready = reject
    })

    function keep(text: string): void {
        lines.push(`${new Date().toISOString()} ${text}`)
        if (lines.length > KEPT_LINES) lines.splice(0, lines.length - KEPT_LINES)
    }

    function hear(line: string): void {
        const said = checked.said(line)
        switch (said.type) {
            case "ready":
                readied(said)
                return
            case "reply": {
                const waiting = asked.get(said.id)
                if (!waiting) throw err("WORLD_REFUSED", { detail: `the world answered request ${said.id}, which nobody asked` })
                asked.delete(said.id)
                waiting.resolve(said.result)
                return
            }
            case "failed": {
                const refusal = err("WORLD_REFUSED", { detail: `${said.code}: ${said.message}` })
                if (said.id === null) {
                    keep(`refused a line: ${said.code}: ${said.message}`)
                    return
                }
                const waiting = asked.get(said.id)
                if (!waiting) throw err("WORLD_REFUSED", { detail: `the world refused request ${said.id}, which nobody asked` })
                asked.delete(said.id)
                waiting.reject(refusal)
                return
            }
            case "event": {
                const text = `${said.kind} at ${said.time.toFixed(2)}s: ${said.detail}`
                keep(text)
                opts.heard({ at: new Date().toISOString(), text: text })
                return
            }
            case "ticked":
                time = said.time
                factor = said.factor
                return
        }
    }

    void read(proc.stdout, line => {
        try {
            hear(line)
        } catch (cause) {
            // The world said something that is not the contract: it is not a world this lab can run.
            keep(cause instanceof Error ? cause.message : String(cause))
            proc.kill()
        }
    })
    void read(proc.stderr, keep)
    void proc.exited.then(code => {
        ended = `the world exited ${code}${lines.length ? ` — last said: ${lines[lines.length - 1]}` : ""}`
        const gone = err("WORLD_REFUSED", { detail: ended })
        unready(gone)
        for (const waiting of asked.values()) waiting.reject(gone)
        asked.clear()
    })

    const timeout = setTimeout(() => unready(err("WORLD_START_FAILED", { detail: `${opts.name} did not say it was ready within ${READY_MS / 1000}s` })), READY_MS)
    let said: world.Ready
    try {
        said = await ready
    } catch (cause) {
        proc.kill()
        throw cause
    } finally {
        clearTimeout(timeout)
    }

    /** A request, answered — or refused, by the world's own code. */
    function ask(request: DistributiveOmit<world.Request, "id">): Promise<unknown> {
        if (ended) return Promise.reject(err("WORLD_NOT_RUNNING", { detail: ended }))
        next += 1
        const id = next
        const answer = new Promise<unknown>((resolve, reject) => {
            asked.set(id, { resolve: resolve, reject: reject })
            setTimeout(() => {
                if (!asked.delete(id)) return
                reject(err("WORLD_REFUSED", { detail: `${request.type} was not answered within ${ANSWER_MS / 1000}s` }))
            }, ANSWER_MS)
        })
        proc.stdin!.write(`${JSON.stringify({ ...request, id: id })}\n`)
        proc.stdin!.flush()
        return answer
    }

    return {
        name: opts.name,
        pid: proc.pid,
        startedAt: startedAt,
        ready: said,
        /** The port players join on: the address the world's `view` names. */
        port: port,
        get ended(): string | null { return ended },
        /** The world's time, and how many of its seconds pass in a wall second, as it last said. */
        get pace(): { time: number; factor: number } { return { time: time, factor: factor } },
        ask: ask,
        log(count: number): string[] {
            return lines.slice(-count)
        },
        /** Closed: every mind told, the process gone. Killed when it does not go on its own. */
        async close(): Promise<void> {
            if (ended) return
            await ask({ type: "close" }).catch(() => undefined)
            proc.stdin!.end()
            const gone = await Promise.race([proc.exited.then(() => true), Bun.sleep(3_000).then(() => false)])
            if (!gone) {
                proc.kill("SIGKILL")
                await proc.exited
            }
        },
    }
}

export type ServedT = Awaited<ReturnType<typeof Served>>

/** A UDP port nothing on this machine holds, as the OS hands one out. */
function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const socket = createSocket("udp4")
        socket.once("error", reject)
        socket.bind(0, "127.0.0.1", () => {
            const port = socket.address().port
            socket.close(() => resolve(port))
        })
    })
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** Each line of a stream, as it arrives. */
async function read(stream: ReadableStream<Uint8Array> | number | undefined, line: (text: string) => void): Promise<void> {
    if (!(stream instanceof ReadableStream)) throw new Error("the world's output is not piped")
    const decoder = new TextDecoder()
    let pending = ""
    for await (const chunk of stream) {
        pending += decoder.decode(chunk, { stream: true })
        let end: number
        while ((end = pending.indexOf("\n")) >= 0) {
            const text = pending.slice(0, end)
            pending = pending.slice(end + 1)
            if (text.trim()) line(text)
        }
    }
}
