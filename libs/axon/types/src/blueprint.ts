import { AxonConfig } from "./config"
import type { CapsulePartialConfig } from "./capsule-config"
import { CognetBlueprint } from "./cognet/blueprint"
import { AxonPlugin } from "./plugin"
import { AxonRoute } from "./route"
import { AxonMiddleware } from "./middleware"
import { AxonModule } from "./module"
import { AxonTool } from "./tools"
import { AxonScript } from "./scripts"
import { AxonPrompt } from "./prompts"
import { AxonKnowledge } from "./knowledge"
import type { ProviderEntry } from "./tui"

/**
 * The blueprint is the boundary between CLI and runtime.
 *
 * The CLI discovers, merges, resolves conflicts, validates, and renders
 * everything ahead of time. The blueprint is the output of that work —
 * a single resolved object handed to Axon(). The runtime never walks
 * the filesystem, never resolves module precedence, never re-validates
 * config. It trusts the blueprint completely and acts on it.
 *
 * If a runtime code path needs to `readdir` or re-derive something the
 * CLI could have resolved, that's a sign the field belongs here instead.
 */
export type AxonBlueprint = {
    session: {
        id: string
    }

    agent: {
        name: string
        version: string
        hash: {
            type: "sha256" | "sha512"
            value: string
        }
    }

    /**
     * Base context — static `src/boot.md`, pre-read by the CLI, rendered as-is.
     * Mutually exclusive with bootFilePath.
     */
    boot?: string

    /**
     * Base context — dynamic `src/boot.vue`. The CLI notes its existence only;
     * the runtime renders it (via vstr, with the real `axon` global in
     * scope) fresh on every tick, so a script-setup call to axon.tools.*
     * reflects live data, not a snapshot from manifest-build time. Mutually
     * exclusive with boot.
     */
    bootFilePath?: string

    /** resolved axon.config.ts — engine, policy, environment. no raw process.env reads at runtime. */
    config: AxonConfig

    /**
     * The machine-wide policy CEILING, from the profile that owns this agent.
     *
     * Kept beside `config.policy` rather than merged into it, deliberately.
     * The two layers stay distinct all the way to enforcement so a denial can
     * name which one produced it — merged, a user reading "denied" would have
     * no way to tell whether to edit their agent or their profile, and
     * removing the agent rule would silently change nothing.
     *
     * Resolved at LOAD, never baked in at prepare: a blueprint travels (it is
     * what `axon deploy` ships), and a deployed agent runs on a machine with
     * no profile. Baking the ceiling in would carry one machine's rules to
     * another, where they describe a filesystem and a threat model that do not
     * exist there.
     *
     * Absent means no ceiling — every capability falls through to the agent's
     * own policy. That is the case for a deployment, for `axon run` outside a
     * profile, and for a profile that simply declares none.
     */
    profilePolicy?: CapsulePartialConfig["policy"]

    /**
     * The inference sources the OWNING PROFILE declares, merged ahead of the
     * agent's own at boot.
     *
     * Resolved at LOAD for the same reason `profilePolicy` is: a blueprint
     * travels — it is what `axon deploy` ships — and a deployed agent runs on
     * a machine with no profile. Baking a user's Ollama daemon into an
     * artifact would carry one machine's inference to another, where it
     * describes a localhost that is not there.
     *
     * Absent means the agent runs on whatever it declares for itself, which
     * for a deployment is the managed route and nothing else.
     */
    profileProviders?: ProviderEntry[]

    /**
     * The brain. REQUIRED and never defaulted: an agent without a brain is
     * not an agent — normalization fails loudly when it's missing. The CLI
     * bundles the cognet project and passes path+hash; tests pass a live
     * definition. The runtime ships no cognet of its own.
     */
    cognet: CognetBlueprint

    /**
     * Full resolved environment, key/value. The CLI is the one place that
     * reads process.env — runtime never reaches for process.env directly,
     * it reads from here so capsule/server/engine all see the same
     * already-resolved set.
     */
    env: Record<string, string>

    /**
     * Host environment the SUPERVISOR needs, and the box must never receive.
     *
     * The split exists because two different processes read from this blueprint
     * and they have opposite trust: the supervisor holds credentials and makes
     * outbound calls on the agent's behalf; the box runs model-emitted code and
     * must hold nothing it does not need. `AXON_API_KEY` is the clear case —
     * the supervisor's cloud client needs it, and it is precisely the value
     * that must not be reachable from inside the box.
     *
     * `env` above is the agent's own `.env`: what a developer put beside their
     * code, and what may cross into the box (subject to policy). This is the
     * host's, and it stops at the boundary.
     */
    hostEnv?: Record<string, string>

    tools: AxonTool[]
    prompts: AxonPrompt[]
    scripts: AxonScript[]
    /**
     * Every knowledge file this agent can reach — its own `data/knowledge/`
     * plus each installed module's, namespaced by module.
     *
     * Discovered at build time and carried as paths, so a module's corpus is
     * never copied into the agent. The kernel enumerates these rather than
     * walking one directory, which is what makes knowledge shareable.
     */
    knowledge: AxonKnowledge[]

    server: AxonServerBlueprint

    /**
     * Installed modules, flattened. Options already validated against each
     * module's optionsSchema by the CLI — runtime trusts the shape.
     */
    modules: AxonModule[]

    /**
     * What the PRIMARY role actually resolved to, as a flat fact.
     *
     * Nothing is declared any more — a user supplies providers, a cognet
     * names roles, and which model serves the cortex is decided at boot by
     * whoever holds the credential. For a confined agent that is the
     * SUPERVISOR: the agent has no credential and therefore cannot resolve,
     * so it cannot answer "which model am I on" from anything it holds.
     *
     * Carried here because the answer is a fact about this boot and every
     * client's header asks for it. `/_axon/health` reported `engine: null`
     * on a perfectly working agent for exactly this reason — it read the
     * kernel's engines, which a confined agent never has.
     *
     * Absent when the cognet declares no roles, or none is primary: a pure
     * control loop genuinely has no model, and inventing one would put a
     * dead row in every client's header.
     */
    engine?: { provider: string; model: string | null }

    paths: {
        /** agent root — still needed for capsule fs-tool sandboxing, not for discovery */
        root: string
        data: string
    }
}

/**
 * What the CLI is allowed to hand over before normalization. Every field is
 * optional or partial — the CLI may not have resolved everything yet (e.g.
 * a fresh session has no id). normalizeBlueprint() is the one place that
 * turns this into a strict AxonBlueprint; nothing downstream ever sees
 * AxonPartialBlueprint.
 */
export type AxonPartialBlueprint = {
    session?: Partial<AxonBlueprint["session"]>
    agent?: Partial<AxonBlueprint["agent"]>
    boot?: string
    bootFilePath?: string
    config?: AxonBlueprint["config"]
    profilePolicy?: AxonBlueprint["profilePolicy"]
    profileProviders?: AxonBlueprint["profileProviders"]
    cognet?: CognetBlueprint
    env?: AxonBlueprint["env"]
    hostEnv?: AxonBlueprint["hostEnv"]
    tools?: AxonBlueprint["tools"]
    prompts?: AxonBlueprint["prompts"]
    scripts?: AxonBlueprint["scripts"]
    knowledge?: AxonBlueprint["knowledge"]
    server?: Partial<AxonServerBlueprint>
    modules?: AxonBlueprint["modules"]
    engine?: AxonBlueprint["engine"]
    paths?: Partial<AxonBlueprint["paths"]>
}


/**
 * Server shape, pre-resolved. Module routes are already merged into `routes`
 * by the CLI (conflict resolution — agent-vs-module precedence, install-order
 * tie-breaks — happened there). build/server/ has no module-specific
 * mounting step; it only applies what it's given.
 */
export type AxonServerBlueprint = {
    middleware: AxonMiddleware[]
    routes: AxonRoute[]      // agent + module routes, fully merged and conflict-resolved
    plugins: AxonPlugin[]
}

