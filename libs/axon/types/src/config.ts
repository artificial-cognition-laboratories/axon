import { CapsulePartialConfig } from "./capsule-config"
import { DeployConfig } from "./deploy"
import { ModuleEntry } from "./module"
import { CognetConfig } from "./cognet/cognet"
import type { ProviderEntry } from "./tui"

/**
 * Authoring configuration for an Axon agent.
 *
 * This is the object passed to `defineAgent()` in `axon.config.ts`. It controls
 * the agent's inference sources, sandbox policy, environment, deployment,
 * installed module options, workspace integration, and HTTP server.
 *
 * ```ts
 * import TelegramModule from "../modules/telegram/module.config"
 *
 * export default defineAgent({
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



    /**
     * Which model drives this agent's cortex.
     *
     * ```ts
     * model: "codex:gpt-5.6-terra"   // a specific route
     * model: "gpt-5.6-terra"         // whichever route supplies it
     * ```
     *
     * A PREFERENCE, never a constraint. Resolution tries the pin first and
     * falls back to ordinary ranking when the user's providers cannot supply
     * it — so a published agent stays runnable by someone who has no Codex
     * connection, rather than carrying its author's account setup as a hard
     * dependency. The role's declared requirements still govern: a pin that
     * names a model too small for the cognet's context is ignored, not
     * honoured into a broken run.
     *
     * A STRING, not a constructor call, because this is the one inference
     * decision a user makes by hand and a picker edits by machine. The old
     * `engine: Codex({ model })` needed AST surgery to change one field; a
     * string is written by whoever is writing it.
     *
     * Applies to the cognet's PRIMARY role only. Which model fills a percept
     * or a compression role is resolution's business — a user choosing those
     * individually is the wiring this design exists to abolish.
     */
    model?: string

    /**
     * Inference sources for THIS agent, appended to whatever the active
     * profile already declares.
     *
     * ```ts
     * providers: [Axon(), Ollama({ url: "http://box.local:11434" })]
     * ```
     *
     * Replaces the old `engine:` field, which named ONE model for the whole
     * agent. That could not survive a cognet declaring several roles, and it
     * put the choice in the wrong place besides: which model to use is the
     * user's, expressed once on their profile, while an agent only says what
     * sources it needs beyond what they already have.
     *
     * Most agents declare nothing: a user's providers live on their profile
     * and every agent inherits them, which is what makes installing an agent
     * a download rather than a setup. This exists for the agent that needs a
     * source its user would not otherwise have — a self-hosted endpoint it
     * ships against, a local daemon it assumes.
     *
     * Additive, never a replacement: an agent cannot take a provider away
     * from the user who is running it.
     */
    providers?: ProviderEntry[]

    /**
     * @deprecated Removed — use `model:` for a pin, `providers:` for sources.
     *
     * ```ts
     * engine: Codex({ model: "gpt-5.6-terra" })   // before
     * model: "codex:gpt-5.6-terra"                // after
     * ```
     *
     * This field named ONE model for the whole agent. It could not survive a
     * cognet declaring several roles, and it put the choice in the wrong
     * place besides — which model to use is the user's, expressed once on
     * their profile, while an agent only says what sources it needs beyond
     * what they already have.
     *
     * Typed as `never` rather than deleted outright. Deleting it made an
     * `engine:` key an ordinary excess property that TypeScript accepted on
     * any non-literal path and the runtime then silently ignored — so an
     * agent kept booting, on whatever the profile pool ranked first, while
     * its config still said otherwise. A dead field that reads as honoured is
     * worse than a missing one. Declaring it `never` makes every assignment a
     * compile error that names the replacement, and `Config()` refuses the
     * key at load for anything that reaches the runtime untypechecked.
     *
     * Remove after the deprecation window, once no published agent carries
     * it.
     */
    engine?: never

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
     * Opt this agent into the repository workspace layer.
     * When true, Axon discovers the nearest .agents/ directory (walking up from cwd)
     * and merges its tools, prompts, scripts, and modules into the agent runtime.
     */
    workspace?: boolean
}