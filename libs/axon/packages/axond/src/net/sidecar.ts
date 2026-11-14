import type { Subprocess } from "bun"
import { err } from "@arcforge/err"

export type SidecarMode = "n0" | "offline"

type SidecarOpts = {
    /** The executable, or null when this install has none. */
    binary: () => string | null
    /** The machine key file, created on demand. */
    key: () => string
    /** The daemon root: `net.sock` is served here, `remote.sock` is expected here. */
    root: string
    mode: SidecarMode
    dialTimeoutMs: number
    /** One structured event the sidecar reported, for the daemon's log. */
    report: (event: Record<string, unknown>) => void
}

/** How long a sidecar has to say it is ready. Offline is near-instant; n0 waits for a relay. */
const READY_MS = 15_000
/** Restart delays after an unexpected exit, capped at the last. */
const BACKOFF_MS = [250, 1_000, 5_000, 15_000]

/**
 * Sidecar — the `axon-net` process, kept running.
 *
 * A manager: the process is `current`, replaced when it dies, and nobody
 * outside holds it. A crash restarts it with backoff and is reported; it never
 * takes the daemon with it, which is the reason it is a separate process.
 */
export function Sidecar(opts: SidecarOpts) {
    let current: Subprocess<"ignore", "ignore", "pipe"> | null = null
    let wanted = false
    let failures = 0
    let problem: string | null = null

    async function spawn(): Promise<void> {
        const binary = opts.binary()
        if (binary === null) {
            problem = "axon-net is not built or installed (cargo build --release in libs/axon/packages/net, or set AXON_NET_BIN)"
            throw err("NET_SIDECAR_DOWN", { detail: problem })
        }
        const proc = Bun.spawn([binary, "serve", "--key", opts.key(), "--root", opts.root, "--mode", opts.mode, "--dial-timeout", String(opts.dialTimeoutMs)], {
            stdin: "ignore",
            stdout: "ignore",
            stderr: "pipe",
        })
        current = proc
        const ready = Promise.withResolvers<void>()
        events(proc, event => {
            if (event.event === "ready") ready.resolve()
            if (event.event === "fatal") ready.reject(err("NET_SIDECAR_DOWN", { detail: String(event.message) }))
            opts.report(event)
        }).catch(cause => opts.report({ event: "events.lost", message: cause instanceof Error ? cause.message : String(cause) }))
        void proc.exited.then(code => exited(proc, code))
        const timeout = setTimeout(() => ready.reject(err("NET_SIDECAR_DOWN", { detail: `axon-net did not report ready within ${READY_MS / 1000}s` })), READY_MS)
        try {
            await ready.promise
            problem = null
            failures = 0
        } finally {
            clearTimeout(timeout)
        }
    }

    function exited(proc: Subprocess, code: number): void {
        if (proc !== current) return
        current = null
        if (!wanted) return
        problem = `axon-net exited with code ${code}`
        opts.report({ event: "exited", code: code })
        const delay = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)]!
        failures++
        setTimeout(() => {
            if (!wanted || current !== null) return
            spawn().catch(cause => opts.report({ event: "restart.failed", message: cause instanceof Error ? cause.message : String(cause) }))
        }, delay)
    }

    return {
        /** Whether a sidecar process is up right now. */
        get running(): boolean {
            return current !== null
        },
        /** Why it is not, when it is not — null while running. */
        get problem(): string | null {
            return current !== null ? null : problem
        },
        /** Start it and wait until it is serving. Throws NET_SIDECAR_DOWN when it cannot. */
        async start(): Promise<void> {
            wanted = true
            if (current === null) await spawn()
        },
        /** Stop it; it is not restarted. */
        async stop(): Promise<void> {
            wanted = false
            const proc = current
            current = null
            if (proc === null) return
            proc.kill("SIGTERM")
            await proc.exited
        },
    }
}

export type SidecarT = ReturnType<typeof Sidecar>

/** Each stderr line is one JSON event; a line that is not is reported as text, never dropped. */
async function events(proc: Subprocess<"ignore", "ignore", "pipe">, each: (event: Record<string, unknown>) => void): Promise<void> {
    let buffered = ""
    for await (const chunk of proc.stderr.pipeThrough(new TextDecoderStream())) {
        buffered += chunk
        let newline: number
        while ((newline = buffered.indexOf("\n")) !== -1) {
            const line = buffered.slice(0, newline).trim()
            buffered = buffered.slice(newline + 1)
            if (line === "") continue
            try {
                each(JSON.parse(line) as Record<string, unknown>)
            } catch {
                each({ event: "output", text: line })
            }
        }
    }
}
