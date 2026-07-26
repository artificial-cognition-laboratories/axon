import { EngineConfig } from "./engine"
import { CapsulePartialConfig } from "./capsule-config"
import { DeployConfig } from "./deploy"
import { ModuleEntry } from "./module"

/**
 * Authoring configuration for an Axon agent.
 *
 * This is the object passed to `defineAgent()` in `axon.config.ts`. It controls
 * the agent's description, inference engine, sandbox policy, environment,
 * deployment, installed module options, workspace integration, and HTTP server.
 *
 * ```ts
 * import { Axon } from "@arcforge/engines"
 * import TelegramModule from "../modules/telegram/module.config"
 *
 * export default defineAgent({
 *     description: "Answers support questions from repository context",
 *     engine: Axon({ model: "auto" }), // curated models
 *     modules: [
 *         "@axon/github",                           // registry — auto-installed
 *         TelegramModule,                           // source import
 *         [TelegramModule, { mentionOnly: true }],  // with options
 *     ],
 * })
 * ```
 *
 * @see https://axon.arclabs.it/docs/v2/agent/config
 */
export type AxonConfig<EventMap extends Record<string, unknown> = Record<string, unknown>> = {
    /** Short human-readable summary shown in registries, docs, and generated manifests. */
    // description?: string // deprected. use package.json instead

    /** Sandbox permissions enforced at the capsule boundary. */
    policy?: CapsulePartialConfig["policy"]

    /** Deployment target, runtime packages, and scaling settings. */
    deploy?: DeployConfig


    /** Engine used for model inference. Omit for mock/default behavior in local scaffolds. */
    engine?: EngineConfig

    /**
     * Cognet selection — which brain the CLI bundles for this agent.
     * Resolved by the CLI against its cognet workspace; defaults to "zero".
     * The runtime never sees this — it reads the bundled blueprint.cognet.
     */
    cognet?: { name: "zero" }



    /**
     * Modules to load into this agent.
     *
     * Each entry is one of:
     * - `"@axon/telegram"` — registry module, auto-installed at `axon prepare` / `axon dev`
     * - `TelegramModule` — direct source import, used from its source path (no install)
     * - `[module, options]` — either form paired with runtime options
     *
     * Modules are loaded in declaration order. Sub-modules declared inside a module
     * are flattened before the agent's own list — first declaration wins on name collision.
     */
    modules?: ModuleEntry[]

    /**
     * Opt this agent into the repository workspace layer.
     * When true, Axon discovers the nearest .agents/ directory (walking up from cwd)
     * and merges its tools, prompts, scripts, and modules into the agent runtime.
     */
    workspace?: boolean
}