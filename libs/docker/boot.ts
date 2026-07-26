import { Boot } from "./lifecycle"

/**
 * Container entrypoint for a deployed Axon agent. Thin: reads the deploy env,
 * calls the Boot orchestrator, and emits the readiness sentinel the local
 * staging pool watches for. All lifecycle logic lives in Boot/Hydrate/Serve.
 *
 * Env:
 *   AGENT_ROOT   — where source lives / will be fetched to (default /agent)
 *   PORT         — port to serve on (default 8080)
 *   AXON_SOURCE  — gs://bucket/path of the source tarball (prod only; absent in
 *                  staging, where the pool has already extracted source to AGENT_ROOT)
 */
const AGENT_ROOT = process.env.AGENT_ROOT ?? "/agent"
const PORT = parseInt(process.env.PORT ?? "8080", 10)
const SOURCE = process.env.AXON_SOURCE

try {
    const { port } = await Boot({
        agentRoot: AGENT_ROOT,
        port: PORT,
        ...(SOURCE ? { source: SOURCE } : {}),
    })

    // Structural readiness: the port is open only after Axon() fully booted, so
    // this line is reached exactly when the agent is genuinely serving. The
    // zero-width-space sentinel is what the staging ProcessPool matches on stdout.
    process.stdout.write(`​[boot:complete] port=${port} root=${AGENT_ROOT}\n`)
} catch (err) {
    console.error("[boot] failed to start:", err)
    process.exit(1)
}
