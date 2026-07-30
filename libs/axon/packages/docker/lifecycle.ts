import { Axon } from "@axon/core"
import { Blueprint } from "@arcforge/platform/build/blueprint"
import { Hydrate } from "./hydrate"
import { Serve } from "./serve"

type BootOpts = {
    /** Directory the runtime scans — source lands here, sessions are written here. */
    agentRoot: string
    /** Port to serve the agent on. */
    port: number
    /** GCS source tarball (prod). Omitted in staging, where source is already at agentRoot. */
    source?: string
}

/**
 * Boot — the deployed-agent container lifecycle, one orchestrator for both
 * environments (Cloud Run and the local staging pool). Pure composition:
 *
 *   Hydrate  → put source at agentRoot (fetch from GCS, or no-op if already there)
 *   Blueprint→ scan agentRoot into a blueprint
 *   Axon     → boot the real, deployment-oblivious runtime (native local fs)
 *   Serve    → bind the port, own the process lifecycle
 *
 * The runtime never knows it is deployed — it scans a folder and serves. Every
 * deployment-specific concern (where source comes from, how the process is
 * torn down) lives in the leaves around it, never inside Axon(). Boot fails
 * loudly at each step: a container that can't hydrate, scan, or boot must NOT
 * report itself ready — the port only opens after Axon() is fully up.
 */
export async function Boot(opts: BootOpts): Promise<{ port: number; stop: () => Promise<void> }> {
    await Hydrate({ agentRoot: opts.agentRoot, ...(opts.source ? { source: opts.source } : {}) })

    const { blueprint } = await Blueprint({ root: opts.agentRoot }).load()
    const runtime = await Axon({ blueprint })

    return Serve({ runtime, port: opts.port })
}
