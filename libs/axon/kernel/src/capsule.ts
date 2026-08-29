import { Capsule, CapsuleT } from "@arcforge/capsule"
import type { CapsulePartialConfig, CapsuleTool } from "@arcforge/capsule"
import { err } from "@arcforge/err"
import { CAPSULE_TRANSIENT_EVENTS, Policy } from "@arcforge/types"
import type { AxonBlueprint, AxonEventMap } from "@arcforge/types"
import type { AxonEscalate, AxonHost } from "@arcforge/types"
import type { KernelBus } from "./contracts"
import type { AxonSessionT } from "@arcforge/session"
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
 * The capsule's policy, resolved.
 *
 * Delegates to Policy() in @arcforge/types — the ONE place a profile ceiling
 * and an agent's own policy become the shape the capsule enforces. This file
 * used to carry that resolution itself (intersect/pairRule/keyed/bucket plus a
 * second POLICY_WILDCARD literal), while the capsule's Blueprint() normalised
 * the result again at its own seam. Two implementations of one rule, kept in
 * step by a test that read both files' source for a matching string literal.
 *
 * They were separate because the mediator is GUEST code and could not import
 * across the subprocess boundary. Resolution now happens above both consumers,
 * so there is one implementation and the guard it needed is gone.
 */
/**
 * Exported so IN-PROCESS mediation enforces the SAME resolved policy the
 * capsule does. Two resolutions of one policy is how a tool ends up permitted
 * on one path and denied on the other, with nothing to say which is right.
 */
export function defaultPolicy(blueprint: AxonBlueprint): CapsulePartialConfig["policy"] {
    return Policy({
        blueprint,
        // Scoped to LOADABLE tools for the same reason toCapsuleTools() is: a
        // rule naming a namespace the capsule never installs grants nothing and
        // only makes the policy surface read as larger than it is.
        tools: blueprint.tools.filter(isLoadable).map(tool => tool.name),
    }).policy
}

type AxonCapsuleOpts = {
    blueprint: AxonBlueprint
    /** Host invocation directory; deliberately independent of the agent project root. */
    cwd: string
    bus: KernelBus
    session: AxonSessionT
    /** The active wake's correlation, or null outside one — capsule spans caused by a run() stamp its runId. */
    run?: () => { runId: string } | null
    boot: boolean
    host?: AxonHost
    /**
     * The platform's policy decider. Handed to the capsule as its `escalate`
     * callback — the one wire that makes a rule saying "escalate" mean
     * anything. Without it the capsule denies after its own timeout, which is
     * how every escalation behaved before this was connected.
     */
    escalate?: AxonEscalate
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
            ...(opts.escalate ? { escalate: opts.escalate } : {}),
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
            // The sandbox reports every cwd change as it happens, so the
            // live location is always known without asking for it.
            if (event.type === "process:cwd") liveCwd = event.cwd
            const { type, ...data } = event
            // onAny is a synchronous listener on the capsule's own bus — it
            // cannot await, so both writes below are fire-and-forget. The
            // catches are load-bearing rather than defensive: every capsule
            // event flows through here, and an unhandled rejection from a
            // full disk or a throwing bus handler would take the whole
            // process down for what is, at worst, one lost telemetry line.
            if (CAPSULE_TRANSIENT_EVENTS.has(type)) {
                void opts.bus.forward(event).catch(() => {})
                return
            }
            void opts.session
                .commit(type, data as AxonEventMap[typeof type], opts.run?.() ?? undefined)
                .catch(() => {})
        })
        await capsule.boot()

        currentId = crypto.randomUUID()
        await opts.session.commit("process:attach", { capsuleId: currentId, cwd: liveCwd ?? opts.cwd })

        return capsule
    }

    /**
     * Commit a detach for whatever capsule id is passed in — always the
     * OUTGOING one, captured by the caller before boot() overwrites
     * currentId with the new capsule's id. Never reads currentId itself:
     * during reload() the new capsule is already live (and currentId
     * already reassigned) by the time the old one's detach is recorded.
     */
    async function detach(capsuleId: string, reason: "shutdown" | "crash" | "reload"): Promise<void> {
        await opts.session.commit("process:detach", { capsuleId, reason })
    }

    async function reload() {
        const previous = current
        const previousId = currentId
        // liveCwd is already current — the outgoing sandbox reported every
        // move as it happened (capsule:cwd), so there is nothing to ask it
        // for on the way out. This used to execute process.cwd() inside a
        // dying incarnation and silently keep a stale value when that failed.
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
