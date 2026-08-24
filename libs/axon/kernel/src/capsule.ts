import { isAbsolute, resolve } from "node:path"
import { Capsule, CapsuleT } from "@axon/capsule"
import type { CapsulePartialConfig, CapsuleTool } from "@axon/capsule"
import { err } from "@arcforge/err"
import { CAPSULE_TRANSIENT_EVENTS, resolveIsolation } from "@arcforge/types"
import type { AxonBlueprint, AxonEventMap, CapsulePolicy, PolicyRule } from "@arcforge/types"
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

    // The two layers, intersected into what the capsule enforces.
    //
    // The profile is a CEILING: an agent narrows within it and can never widen
    // it. Resolved HERE rather than in the TUI, because this is the one seam
    // every consumer passes through — `axon dev`, `axon run` in a script, a
    // test harness. A ceiling applied only on the TUI's spawn path would be
    // advisory, and the CLI is exactly where someone scripting would bypass it
    // without meaning to.
    // Both layers normalised to the KEYED shape before they meet.
    //
    // A bare `tools: "escalate"` is an authoring convenience; every rule below
    // — the pairing, the wildcard lookup, the mediator — reads one shape. Doing
    // it here rather than in each of them is the same discipline Blueprint()
    // applies at the capsule seam.
    const userPolicy = intersect(
        blueprint.profilePolicy ? keyed(blueprint.profilePolicy) : undefined,
        keyed(blueprint.config.policy ?? {}),
    )

    // The invariant: not setting a security policy means "I don't care" — the
    // agent gets full access to the machine, no hassle, no dependencies. Setting
    // ANY containment intent (fs/network/limits) opts into rootless confinement,
    // which needs no privilege and just works. A user can always name isolation
    // explicitly to force a tier (e.g. "hardened", or "none" despite having fs).
    //
    // Read off the INTERSECTED policy, so a profile declaring containment opts
    // every agent on the machine into it — an agent that declares nothing still
    // gets the wall its profile asked for.
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

/**
 * Intersect the profile ceiling with an agent's own policy.
 *
 * ── Why this is a UNION of keys, not of permissions ─────────────────────────
 *
 * Both layers' rules are carried forward per capability, and the MEDIATOR
 * evaluates the pair at call time (see resolveVerdict in @arcforge/types).
 * That split is deliberate: merging two glob rules into one is where a ceiling
 * silently springs a leak — `allow: ["git status"]` unioned with
 * `allow: ["git push"]` permits a command neither layer permitted alone.
 *
 * So this composes the SHAPE (which capabilities each layer has an opinion
 * about) and leaves the VERDICT to per-call evaluation, where both rules are
 * still separately available and the answer can name which one decided.
 *
 * ── The bare cases collapse here ────────────────────────────────────────────
 *
 * `true`/`false`/`"escalate"` carry no patterns, so there is nothing to defer:
 * a profile `false` is final regardless of what the agent says, and a profile
 * `true` adds no constraint the agent could violate. Collapsing them at this
 * seam keeps the common case (a profile that just says "no shell") from
 * costing a pair lookup on every call.
 *
 * fs and limits are NOT intersected: they are OS-layer facts (bind mounts,
 * cgroups) with no verdict to evaluate, and the mediator never sees them. The
 * profile's are taken when present, since a ceiling that a bind mount ignores
 * is not a ceiling.
 */
function intersect(
    profile: NormalizedPolicy | undefined,
    agent: NormalizedPolicy,
): NormalizedPolicy {
    if (!profile) return agent

    return {
        ...agent,
        isolation: resolveIsolation(profile.isolation, agent.isolation) ?? agent.isolation,

        // The OS wall. A profile grant is the outer bound, so an agent's paths
        // are kept only where the profile has no opinion at all — otherwise a
        // narrower mount would have to be computed, which bind mounts cannot
        // express as an intersection of globs.
        ...(profile.fs ? { fs: profile.fs } : {}),
        ...(profile.limits ? { limits: profile.limits } : {}),

        ...(profile.network || agent.network
            ? { network: pairRules(profile.network, agent.network) }
            : {}),
        ...(profile.tools || agent.tools
            ? { tools: pairRules(profile.tools, agent.tools) }
            : {}),

        process: {
            spawn: pairRule(profile.process?.spawn, agent.process?.spawn),
            run: pairRule(profile.process?.run, agent.process?.run),
        },
    }
}

/**
 * One capability's rule under both layers.
 *
 * A bare profile verdict wins outright — it cannot be narrowed further by a
 * pattern and cannot be widened at all. Otherwise the agent's rule stands and
 * the profile's is carried alongside for the mediator to evaluate against.
 */
function pairRule(profile: PolicyRule | undefined, agent: PolicyRule | undefined): PolicyRule {
    if (profile === false) return false
    if (profile === "escalate" && agent !== false) return "escalate"
    if (profile === undefined) return agent ?? true
    if (profile === true) return agent ?? true
    // Profile is glob-shaped: the agent narrows within it, and the pair is
    // evaluated per call. With no agent rule, the profile IS the rule.
    return agent ?? profile
}

/** pairRule across two keyed maps, over the union of their keys. */
function pairRules(
    profile: Record<string, PolicyRule> | undefined,
    agent: Record<string, PolicyRule> | undefined,
): Record<string, PolicyRule> {
    const keys = new Set([...Object.keys(profile ?? {}), ...Object.keys(agent ?? {})])
    const out: Record<string, PolicyRule> = {}

    // A profile WILDCARD applies to every key, not only to `*`.
    //
    // Without this the ceiling leaks in exactly the case the wildcard exists
    // for: a profile saying `tools: "escalate"` normalises to `{ "*":
    // "escalate" }`, an agent's `tools: { fs: true }` keeps its own key, and
    // the mediator's exact-match then hands back `true` — the profile's
    // blanket never consulted. A ceiling a named grant can punch through is
    // not a ceiling.
    //
    // Paired per key rather than replacing the agent's rule, so the profile's
    // blanket and the agent's specific are BOTH carried to the mediator and
    // the verdict can still name which layer decided.
    const blanket = profile?.[POLICY_WILDCARD]

    for (const key of keys) out[key] = pairRule(profile?.[key] ?? blanket, agent?.[key])
    return out
}


/** The key a blanket rule normalises to — mirrors POLICY_WILDCARD in @axon/capsule. */
const POLICY_WILDCARD = "*"

/**
 * One authored policy, with every bare surface rule expanded to `{ "*": rule }`.
 *
 * `tools: "escalate"` and `tools: { "*": "escalate" }` are the same statement;
 * this makes them the same VALUE, so nothing downstream has to ask which was
 * written. `process` is a fixed pair rather than an open bucket, so a bare rule
 * there applies to both verbs instead of becoming a key no verb would match.
 */
function keyed(policy: NonNullable<CapsulePartialConfig["policy"]>): NormalizedPolicy {
    const { tools, network, process: proc, ...rest } = policy
    return {
        ...rest,
        ...(tools !== undefined ? { tools: bucket(tools) } : {}),
        ...(network !== undefined ? { network: bucket(network) } : {}),
        ...(proc !== undefined
            ? { process: isBareRule(proc) ? { spawn: proc, run: proc } : proc }
            : {}),
    }
}

type NormalizedPolicy = Omit<NonNullable<CapsulePartialConfig["policy"]>, "tools" | "network" | "process"> & {
    tools?: Record<string, PolicyRule>
    network?: Record<string, PolicyRule>
    process?: Partial<CapsulePolicy["process"]>
}

function bucket(value: NonNullable<CapsulePartialConfig["policy"]>["tools"]): Record<string, PolicyRule> {
    if (value === undefined) return {}
    return isBareRule(value) ? { [POLICY_WILDCARD]: value } : value
}

/** A rule with no keys of its own — `true`, `false`, `"escalate"`, or a glob object. */
function isBareRule(value: unknown): value is PolicyRule {
    if (typeof value === "boolean" || value === "escalate") return true
    if (typeof value !== "object" || value === null) return false
    const keys = Object.keys(value)
    return keys.length > 0 && keys.every(key => key === "allow" || key === "deny" || key === "escalate")
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
            if (event.type === "capsule:cwd") liveCwd = event.cwd
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
        await opts.session.commit("capsule:attach", { capsuleId: currentId, cwd: liveCwd ?? opts.cwd })

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
        await opts.session.commit("capsule:detach", { capsuleId, reason })
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
