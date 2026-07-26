import { AxonConfig } from "./config"
import { CognetBlueprint } from "./cognet/blueprint"
import { AxonPlugin } from "./plugin"
import { AxonRoute } from "./route"
import { AxonMiddleware } from "./middleware"
import { AxonModule } from "./module"
import { AxonTool } from "./tools"
import { AxonScript } from "./scripts"
import { AxonPrompt } from "./prompts"

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

    tools: AxonTool[]
    prompts: AxonPrompt[]
    scripts: AxonScript[]

    server: AxonServerBlueprint

    /**
     * Installed modules, flattened. Options already validated against each
     * module's optionsSchema by the CLI — runtime trusts the shape.
     */
    modules: AxonModule[]

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
    cognet?: CognetBlueprint
    env?: AxonBlueprint["env"]
    tools?: AxonBlueprint["tools"]
    prompts?: AxonBlueprint["prompts"]
    scripts?: AxonBlueprint["scripts"]
    server?: Partial<AxonServerBlueprint>
    modules?: AxonBlueprint["modules"]
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

