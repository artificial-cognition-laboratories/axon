import { err } from "@arcforge/err"
import type { PlatformT } from "@arcforge/platform"
import type { AgentsT } from "../agents/index"

/** An agent the daemon booted, by reference: what a caller needs to talk to it, find its sessions, and stop it. */
export type Launched = {
    session: string
    /** The agent's name, as its project declares it. */
    name: string
    /** The agent's project folder — where its sessions are recorded. */
    root: string
    link: { request(input: unknown): Promise<unknown> }
    /** Shuts it down through its link, which drains it and closes its session log. */
    stop(): Promise<void>
}

/**
 * Launcher — boots an agent the daemon was asked to run, by reference (a path,
 * a profile name, `@scope/name`), and supervises it.
 *
 * ── Why the daemon builds a Platform ────────────────────────────────────────
 *
 * Booting an agent needs a PREPARED blueprint, and preparing one — resolving
 * the reference, opening the project, installing, generating types — is the
 * platform's work and needs the whole project stack. The daemon deliberately
 * does not contain that.
 *
 * It does not have to. `Platform` takes a supervisor as a SEAM
 * (`InstancesOpts.daemon`, documented as "`Axond().agents` today"), so the
 * daemon can hold a platform purely as a blueprint builder and still be the
 * thing that owns the process. Platform builds; the daemon runs.
 *
 * ── Lazy, and deliberately so ───────────────────────────────────────────────
 *
 * `Platform()` reads the store and the active profile at construction. A
 * daemon that built one at boot would fail to start on a machine nobody has
 * logged into, and would hold a profile captured before the user switched. It
 * is built on the first launch that needs it.
 *
 * Shared by everything in the daemon that boots agents — a job's run, a lab's
 * scenario run — so there is one platform and one way to do it.
 */
export function Launcher(opts: { agents: AgentsT; version?: string }) {
    let platform: PlatformT | null = null

    async function current(): Promise<PlatformT> {
        if (platform) return platform
        // Imported here rather than at module scope: the daemon must be
        // constructible without the platform's whole dependency graph loaded.
        const { Platform } = await import("@arcforge/platform")
        platform = Platform({
            version: opts.version ?? "0.0.0",
            // The seam. The daemon holds the credential and owns the process;
            // the platform only builds what gets booted.
            daemon: opts.agents,
        })
        return platform
    }

    return {
        /** The agent every machine has, made sure of: what a job with no agent named is given. */
        async zeno(): Promise<string> {
            const host = await current()
            await host.agents.zeno.ensure()
            return host.agents.zeno.name
        },
        async launch(ref: string, input: { job?: string } = {}): Promise<Launched> {
            const host = await current()
            const project = await host.agents.resolve(ref)
            const instance = await host.agents.spawn(project, input.job ? { job: input.job } : {})
            if (instance.source.kind !== "linked") {
                throw err("CLI_AGENT_NOT_LOCAL", {
                    detail: `${ref} resolved to an agent that is not running on this machine`,
                    context: { session: instance.sessionId },
                })
            }
            const source = instance.source
            return {
                session: instance.sessionId,
                name: source.project.name,
                root: source.project.root,
                link: source.agent.link,
                stop: () => host.agents.stop(instance.sessionId),
            }
        },
    }
}

export type LauncherT = ReturnType<typeof Launcher>
