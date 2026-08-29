import type { Axon } from "@arcforge/core"

type Runtime = Awaited<ReturnType<typeof Axon>>

type ServeOpts = {
    runtime: Runtime
    port: number
}

/**
 * Serve — binds the runtime's web fetch handler to a port and owns the process
 * lifecycle for a deployed agent (SIGTERM → graceful shutdown, crash guards).
 *
 * Readiness is structural, not a signal: the server only begins listening
 * AFTER Axon() has fully booted (the caller awaits Boot before Serve), so the
 * moment the port accepts connections the agent is genuinely ready. The
 * framework /_axon/health route answers as soon as the port is up — which is
 * exactly the readiness the Cloud Run startup probe checks. There is no window
 * where the port is open but the runtime is half-built.
 */
export function Serve(opts: ServeOpts): { port: number; stop: () => Promise<void> } {
    const server = Bun.serve({
        port: opts.port,
        fetch: request => opts.runtime.server.handler(request),
    })

    let shuttingDown = false
    async function stop(): Promise<void> {
        if (shuttingDown) return
        shuttingDown = true
        try {
            await opts.runtime.shutdown()
        } finally {
            server.stop(true)
        }
    }

    process.on("SIGTERM", () => {
        void stop().then(() => process.exit(0))
    })
    process.on("SIGINT", () => {
        void stop().then(() => process.exit(0))
    })
    process.on("uncaughtException", err => {
        console.error("[serve] uncaught exception:", err)
        process.exit(1)
    })
    process.on("unhandledRejection", err => {
        console.error("[serve] unhandled rejection:", err)
    })

    return { port: server.port ?? opts.port, stop }
}
