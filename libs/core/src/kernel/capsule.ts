import { isAbsolute, resolve } from "node:path"
import { Capsule, CapsuleT } from "@axon/capsule"
import type { CapsulePartialConfig, CapsuleTool } from "@axon/capsule"
import { err } from "@axon/err"
import { CAPSULE_TRANSIENT_EVENTS } from "@arcforge/types"
import type { AxonBlueprint, AxonEventMap, CapsulePolicy } from "@arcforge/types"
import type { AxonHost } from "../Axon"
import { AxonBusT } from "../platform/bus"
import type { AxonSessionT } from "./session"
import { isLoadable, toScopeModule } from "./scope"

/**
 * Project-scanned tools carry self-contained bundled source (produced at scan
 * time, with the tool's own imports inlined). The capsule materializes that
 * source inside the sandbox and imports it there, so NO tool file — and none of
 * the project around it — is ever mounted into the box. This is what keeps the
 * sandbox filesystem exactly what the fs policy declares and nothing more. A
 * raw entryPath is a fallback only for programmatic blueprints that never went
 * through scan/bundling.
 *
 * Membership is isLoadable()/toScopeModule() from ./scope — the same
 * decision that produces the model's <scope> and the editor's ambient
 * declarations. What the capsule can run, what the model is told it can
 * call, and what an editor typechecks against are one list by construction.
 */
function toCapsuleTools(blueprint: AxonBlueprint): CapsuleTool[] {
    return blueprint.tools
        .filter(isLoadable)
        .map(tool => ({
            namespace: tool.name,
            scope: toScopeModule(tool),
            // Bundled source is authoritative: the capsule materializes it inside
            // the sandbox, so no tool file (and none of the project around it) is
            // mounted into the box. entryPath is a fallback only for tools that
            // were never bundled (programmatic blueprints); scanned tools always
            // carry source now.
            ...(tool.source ? { source: tool.source } : { path: tool.entryPath! }),
        }))
}

/**
 * The capsule's own defaults are deny-by-default — correct for a sandbox
 * that must never silently grant an undeclared capability to arbitrary
 * loaded code. Axon is a different trust boundary: it is wiring up a
 * capsule for its OWN declared blueprint, not sandboxing foreign code, so
 * its default posture is the opposite — allow everything the blueprint's
 * own policy doesn't explicitly restrict. Every tool namespace actually
 * installed in the capsule gets an allow rule unless the blueprint's policy
 * says otherwise; the user's own policy always wins (spread last).
 *
 * Scoped to loadable tools for the same reason toCapsuleTools() is: a rule
 * naming a namespace the capsule never installs grants nothing and only
 * makes the policy surface read as larger than it is.
 */
function defaultPolicy(blueprint: AxonBlueprint): CapsulePartialConfig["policy"] {
    const tools: Record<string, true> = {}
    for (const tool of blueprint.tools.filter(isLoadable)) tools[tool.name] = true

    const userPolicy = blueprint.config.policy ?? {}

    // The invariant: not setting a security policy means "I don't care" — the
    // agent gets full access to the machine, no hassle, no dependencies. Setting
    // ANY containment intent (fs/network/limits) opts into rootless confinement,
    // which needs no privilege and just works. A user can always name isolation
    // explicitly to force a tier (e.g. "hardened", or "none" despite having fs).
    const wantsContainment =
        userPolicy.fs !== undefined || userPolicy.network !== undefined || userPolicy.limits !== undefined
    const isolation = userPolicy.isolation ?? (wantsContainment ? "auto" : "none")

    return {
        ...userPolicy,
        isolation,
        // fs paths are authored relative to the AGENT PROJECT, not the directory
        // the user happened to launch from. `fs: { read: ["./workspace"] }` in
        // agents/foo/axon.config.ts means agents/foo/workspace, wherever axon
        // was run. Resolve against paths.root here, at the seam that knows it —
        // the capsule only ever sees absolute paths.
        ...(userPolicy.fs ? { fs: resolveFsPaths(userPolicy.fs, blueprint.paths.root) } : {}),
        process: { spawn: true, run: true, ...userPolicy.process },
        tools: { ...tools, ...userPolicy.tools },
    }
}

/** Resolve an fs policy's relative paths against the agent project root. */
function resolveFsPaths(fs: NonNullable<CapsulePolicy["fs"]>, root: string): CapsulePolicy["fs"] {
    const abs = (p: string) => (isAbsolute(p) ? p : resolve(root, p))
    return {
        ...(fs.read ? { read: fs.read.map(abs) } : {}),
        ...(fs.write ? { write: fs.write.map(abs) } : {}),
    }
}

type AxonCapsuleOpts = {
    blueprint: AxonBlueprint
    /** Host invocation directory; deliberately independent of the agent project root. */
    cwd: string
    bus: AxonBusT
    session: AxonSessionT
    /** The active wake's correlation, or null outside one — capsule spans caused by a run() stamp its runId. */
    run?: () => { runId: string } | null
    boot: boolean
    host?: AxonHost
}

/**
 * Owns the current capsule instance — ring 3, the unprivileged userland the
 * kernel spawns agent-emitted effects into. Single entry point: callers
 * always go through `current`, never hold the handle directly, so a reload
 * can swap the underlying process without anyone needing to know.
 *
 * Capsule events commit to the session's log (telemetry view) —
 * untranslated, the capsule's own vocabulary, stamped with the active
 * wake's runId so cmd/fn spans attribute to the run that caused them; the
 * commit pipeline forwards to the bus after each append lands. The one
 * exception is the byte streams (CAPSULE_TRANSIENT_EVENTS: cmd/proc
 * stdout, console) — live wire material that never enters the log; a
 * command's output already reaches the durable record folded into
 * cognet:action:result. capsule:attach/detach — "is a capsule live
 * right now" — is the runtime's own continuity fact, committed here at
 * the lifecycle seams alongside boot/shutdown.
 */
export async function AxonCapsule(opts: AxonCapsuleOpts) {
    let blueprint = opts.blueprint
    let current: CapsuleT | undefined
    let currentId: string | undefined
    // The agent's live working directory, as last observed inside the
    // sandbox — distinct from opts.cwd (the fixed host invocation dir).
    // Starts unset: the very first boot has no prior capsule to inherit
    // from, so it correctly falls back to opts.cwd below.
    let liveCwd: string | undefined

    function config(): CapsulePartialConfig {
        return {
            name: blueprint.agent.name,
            cwd: liveCwd ?? opts.cwd,
            env: blueprint.env,
            tools: toCapsuleTools(blueprint),
            policy: defaultPolicy(blueprint),
            ...(opts.host ? {
                host: {
                    call: request => opts.host!.call({
                        callerSessionId: opts.session.id,
                        ...request,
                    }),
                },
            } : {}),
        }
    }

    async function boot(): Promise<CapsuleT> {
        const capsule = Capsule(config())
        capsule.onAny((event) => {
            const { type, ...data } = event
            if (CAPSULE_TRANSIENT_EVENTS.has(type)) {
                void opts.bus.forward(event)
                return
            }
            void opts.session.commit(type, data as AxonEventMap[typeof type], opts.run?.() ?? undefined)
        })
        await capsule.boot()

        currentId = crypto.randomUUID()
        await opts.session.commit("capsule:attach", { capsuleId: currentId, cwd: liveCwd ?? opts.cwd })

        return capsule
    }

    /**
     * The declared contract (see scope/declarations.ts) is "cwd changes
     * persist across blocks" — true within one capsule's lifetime, silently
     * false across a reload unless the incoming capsule inherits where the
     * outgoing one actually was. Best-effort: a query that fails (dead
     * incarnation, mid-crash) falls back to the last known liveCwd, not a
     * hard failure — reload must not abort because the outgoing capsule
     * can't answer one last question.
     */
    async function captureLiveCwd(capsule: CapsuleT): Promise<void> {
        try {
            const result = await capsule.run("process.cwd()", { timeout: 5_000 })
            if (typeof result === "string" && result.length > 0) liveCwd = result
        } catch {
            // Outgoing capsule couldn't answer — keep whatever liveCwd already holds.
        }
    }

    /**
     * Commit a detach for whatever capsule id is passed in — always the
     * OUTGOING one, captured by the caller before boot() overwrites
     * currentId with the new capsule's id. Never reads currentId itself:
     * during reload() the new capsule is already live (and currentId
     * already reassigned) by the time the old one's detach is recorded.
     */
    async function detach(capsuleId: string, reason: "shutdown" | "crash" | "reload"): Promise<void> {
        await opts.session.commit("capsule:detach", { capsuleId, reason })
    }

    async function reload() {
        const previous = current
        const previousId = currentId
        if (previous) await captureLiveCwd(previous)
        current = await boot()
        await previous?.shutdown()
        if (previousId) await detach(previousId, "reload")
    }

    if (opts.boot) current = await boot()

    return {
        get current(): CapsuleT {
            if (!current) throw err("CAPSULE_ACCESSED_BEFORE_BOOT")
            return current
        },

        async boot() {
            current = await boot()
        },

        /**
         * Receives the full re-normalized blueprint from the kernel.
         * The capsule process is rebuilt against it — new one goes live
         * before the old one drops.
         */
        async update(next: AxonBlueprint) {
            blueprint = next
            await reload()
        },

        reload,

        async shutdown() {
            await current?.shutdown()
            current = undefined
            if (currentId) {
                await detach(currentId, "shutdown")
                currentId = undefined
            }
        },
    }
}

export type AxonCapsuleT = Awaited<ReturnType<typeof AxonCapsule>>
