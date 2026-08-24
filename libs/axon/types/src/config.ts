import { EngineConfig } from "./engine"
import { CapsulePartialConfig } from "./capsule-config"
import { DeployConfig } from "./deploy"
import { ModuleEntry } from "./module"
import { CognetConfig } from "./cognet/cognet"

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

    /**
     * Paths on this agent's own HTTP surface worth surfacing to whoever boots
     * it — printed in the `axon dev` banner alongside the agent's URL.
     *
     * ```ts
     * links: { viewer: "/api/sim", docs: "/api/help" }
     * ```
     *
     * Values are PATHS, never absolute URLs: the runtime binds a port at boot
     * (walking forward if the requested one is taken), so an agent that wrote
     * `http://localhost:3010/...` here would advertise the wrong address the
     * first time two agents ran side by side.
     *
     * The runtime attaches no meaning to a name. It does not know what a
     * viewer is, only that the author wants this path shown — which is why
     * this is a flat label→path map rather than a typed `ui:` field with a
     * title and an icon. A shape that describes what the thing IS would be
     * the runtime learning about kinds of page; this shape only says where.
     */
    links?: Record<string, string>

    /** Sandbox permissions enforced at the capsule boundary. */
    policy?: CapsulePartialConfig["policy"]

    /** Deployment target, runtime packages, and scaling settings. */
    deploy?: DeployConfig


    /** Engine used for model inference. Omit for mock/default behavior in local scaffolds. */
    engine?: EngineConfig

    /**
     * Cognet selection — which brain this agent runs.
     *
     * Two forms, exactly like a module:
     *
     * - `"@axon/zero"` — a scoped registry specifier, optionally
     *   version-pinned (`"@axon/zero@^0.2.0"`). Installed as a package.json
     *   dependency at `axon prepare` and compiled into the agent, so versions
     *   resolve and lock through Bun like any other dependency.
     * - `Vehicle` — a direct source import of a `cognet.config.ts`, compiled
     *   from its own directory with no install step. The path comes from the
     *   import statement, resolved statically at prepare.
     *
     * ```ts
     * import Vehicle from "../../cognets/braitenberg-vehicle/cognet.config"
     * export default defineAgent({ cognet: Vehicle })
     * ```
     *
     * Omitted entirely, the agent tracks the registry's latest `@axon/zero`
     * for this kernel ABI — choosing nothing is not the same as choosing the
     * default.
     *
     * Exactly one per agent — an agent has one brain. The runtime never sees
     * this field; it reads the bundled blueprint.cognet.
     */
    cognet?: string | CognetConfig



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
     * Prompt packages to load into this agent.
     *
     * Each entry is a registry name — `"@cody/eslint-scout"` — auto-installed
     * at `axon prepare` / `axon dev` like a module. Every top-level .vue/.md
     * in the package becomes an invokable prompt, namespaced by the package
     * so an installed one can never shadow the agent's own:
     *
     *     src/prompts/scout.vue     → `axon run scout`
     *     @cody/eslint-scout:scout  → `axon run @cody/eslint-scout:scout`
     *
     * A prompt is the smallest shareable unit of work — an instruction, not a
     * capability. Modules bring tools; prompts bring tasks.
     */
    prompts?: string[]

    /**
     * Opt this agent into the repository workspace layer.
     * When true, Axon discovers the nearest .agents/ directory (walking up from cwd)
     * and merges its tools, prompts, scripts, and modules into the agent runtime.
     */
    workspace?: boolean
}