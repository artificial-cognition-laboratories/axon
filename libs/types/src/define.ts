import type { AxonConfig } from "./config"
import type { BenchConfig, BenchDefinition } from "./bench"
import type { ModuleConfig, ModuleEmitMap, ModuleOptionSchema } from "./module"
import type { AxonPlugin } from "./plugin"
import type { AxonHandle } from "./handle"

/** Return shape produced by `defineAgent()`. */
export type AgentDefinition<EventMap extends Record<string, unknown> = Record<string, unknown>> = {
    _kind: "agent"
    config: AxonConfig<EventMap>
}

/**
 * Defines an Axon agent configuration.
 *
 * Use this as the default export from `axon.config.ts`. The helper preserves
 * the exact shape of your config for editor inference while marking the export
 * as an Axon agent definition for the CLI and runtime.
 *
 * ```ts
 * import { Axon } from "@arcforge/engines"
 *
 * export default defineAgent({
 *     description: "Reviews incoming pull requests",
 *     engine: Axon({ model: "claude-sonnet-4-6" }),
 *     policy: {
 *         fs: { read: ["./src/**"], write: ["./reports/**"] },
 *         network: { allow: ["api.github.com"] },
 *     },
 * })
 * ```
 *
 * @see https://axon.arclabs.it/docs/v2/agent/config
 * @see https://axon.arclabs.it/docs/v2/api/config/engine
 * @see https://axon.arclabs.it/docs/v2/api/config/policy
 */
export function defineAgent<EventMap extends Record<string, unknown> = Record<string, unknown>>(
    config: AxonConfig<EventMap>
): AgentDefinition<EventMap> {
    return { _kind: "agent", config }
}

/**
 * Defines a reusable Axon module configuration.
 *
 * Use this as the default export from `module.config.ts`. Modules can contribute
 * tools, prompts, scripts, routes, environment requirements, policy needs, and
 * boot-time setup hooks to any agent that installs them.
 *
 * ```ts
 * export default defineModule({
 *     name: "github",
 *     description: "GitHub issue and pull request tools",
 *     options: {
 *         owner: { type: "string", required: true },
 *         repo: { type: "string", required: true },
 *     },
 *     env: {
 *         GITHUB_TOKEN: { required: true, description: "Token used for GitHub API calls" },
 *     },
 * })
 * ```
 *
 * @see https://axon.arclabs.it/docs/v2/modules/config
 * @see https://axon.arclabs.it/docs/v2/modules/building
 */
/**
 * Defines a benchmark configuration.
 *
 * Use this as the default export from `bench.config.ts`. Declares which
 * control axes the harness sweeps. Tasks remain ordinary Bun tests; this
 * file only declares the experiment applied to them.
 *
 * ```ts
 * export default defineBench({
 *     description: "Software engineering tasks",
 *     factors: [{
 *         id: "model",
 *         label: "Model",
 *         kind: "model",
 *         role: "subject",
 *         values: [sonnet, haiku],
 *     }],
 *     measurements: [{
 *         id: "correct",
 *         label: "Correct",
 *         description: "Whether the answer is correct",
 *         value: { kind: "boolean" },
 *         aggregate: "rate",
 *     }],
 *     trials: 5,
 *     tests: ["tests/<glob>.bench.ts"],
 * })
 * ```
 *
 * @see https://axon.arclabs.it/docs/v2/bench/config
 */
export function defineBench(config: BenchConfig): BenchDefinition {
    return { _kind: "bench", config }
}

/**
 * Defines a reusable Axon module. The default export of `module.config.ts`.
 *
 * Pure identity — it returns the config unchanged. A module's file path (its
 * `configPath`) is NOT recovered here: the blueprint scanner resolves it
 * statically from the `import` statements in the agent config that declares
 * the module, so there is no runtime stack to walk and no bundler-renamed
 * filename to match. `defineModule` exists purely for editor inference and to
 * mark intent; it does no work.
 *
 * The config's executable half (`setup`, and any hooks it registers) is run
 * at agent boot by the core runtime, which imports the module by its resolved
 * `configPath`. The static half (`env`, `options`, `emits`, `policy`) is read
 * by the scanner from the file's AST.
 */
export function defineModule<
    O extends Record<string, ModuleOptionSchema>,
    E extends ModuleEmitMap,
>(config: ModuleConfig<O, E>): ModuleConfig<O, E> {
    return config
}

/**
 * Declares typed arguments for the current script.
 *
 * This is a compile-time authoring macro. At runtime, Axon injects the script's
 * arguments before the script runs; `defineArgs<T>()` gives those values a type
 * and lets `axon prepare` extract the argument schema for generated declarations
 * and CLI help.
 *
 * ```ts
 * const { issueId, title } = defineArgs<{
 *     issueId: string
 *     title?: string
 * }>()
 *
 * await axon.request(`Triaging ${issueId}: ${title ?? "untitled"}`)
 * ```
 *
 * @see https://axon.arclabs.it/docs/v2/api/scripts
 * @see https://axon.arclabs.it/docs/v2/agent/src/scripts
 */
export function defineArgs<T extends Record<string, unknown>>(): T {
    return (globalThis as any).args as T
}

/**
 * Declares typed props for a dynamic Vuedown prompt component.
 *
 * Use this in prompt/component `.vue` files when the template expects variables.
 * `axon prepare` reads the generic type and generates typed `axon.prompt()`
 * overloads, so callers must pass the props your prompt requires.
 *
 * ```ts
 * const { domain, limit = 5 } = defineProps<{
 *     domain: string
 *     limit?: number
 * }>()
 * ```
 *
 * @see https://axon.arclabs.it/docs/v2/api/prompt
 * @see https://axon.arclabs.it/docs/v2/concepts/vuedown
 */
export function defineProps<T extends Record<string, unknown>>(): T {
    return (globalThis as any).__axon_skill_props__ as T
}

/**
 * Registers a boot-time server plugin.
 *
 * Use this as the default export from `server/plugins/*.ts`. The callback runs
 * once, after middleware and before routes are mounted, and receives the live
 * `axon` handle to subscribe to hooks and wire behavior. A throwing plugin
 * aborts boot — plugin failure is always fatal.
 *
 * ```ts
 * export default defineAxonPlugin(async (axon) => {
 *     axon.hooks.hook("telegram:message", async ({ text, reply }) => {
 *         const result = await axon.request({ prompt: text })
 *         await reply(result.text)
 *     })
 * })
 * ```
 *
 * The `axon` handle is passed in by the runtime that boots the plugin — never
 * read from a global — so a plugin is always bound to its own Axon() instance
 * even when a host runs several at once.
 *
 * @see https://axon.arclabs.it/docs/v2/agent/server
 */
export function defineAxonPlugin(fn: (axon: AxonHandle) => void | Promise<void>): AxonPlugin {
    return { name: fn.name || "plugin", fn }
}

/** Handle returned by the test-runtime spawner `Axon()`. */
export type AxonTestHandle = {
    axon: AxonHandle
    stop: () => Promise<void>
}

/**
 * Boots a full Axon runtime for integration testing. Global in test files — no
 * import needed. The runtime is torn down by calling `stop()`.
 *
 * ```ts
 * const { axon, stop } = await Axon()
 * const result = await axon.request("hello")
 * await stop()
 * ```
 *
 * @see https://axon.arclabs.it/docs/v2/agent/testing
 */
export type AxonTest = () => Promise<AxonTestHandle>
