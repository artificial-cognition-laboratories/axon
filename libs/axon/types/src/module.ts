import type { AxonPrompt } from "./prompts"
import type { AxonScript } from "./scripts"
import type { AxonTool } from "./tools"
import type { AxonEntry } from "./session/session"
import type { AxonStimulusEvent, AxonStimulusType } from "./session/events/stdio/stimuli"

/**
 * A resolved, installed module as it appears in the blueprint — surfaces
 * plus the overlay metadata the runtime needs (roots for capsule loading,
 * validated options, declared env requirements).
 */
export type AxonModule = {
    /** Module name (short form, e.g. "telegram") — how tools and options key off it. */
    name: string
    /**
     * Full package name, e.g. "@axon/telegram" — the module's registry
     * identity, present whenever it ships a package.json. This is what
     * install/uninstall address it by; `name` is the short form used for
     * namespacing and cannot round-trip to the registry.
     */
    packageName?: string
    /** Package version, when the module ships a package.json. */
    version?: string
    /** Absolute path to the module root. */
    root: string
    /**
     * Absolute path to the module's `module.config.ts`. The core runtime
     * imports this at boot to run the module's `setup()`. Resolved statically
     * by the scanner from the agent config's import of this module — never
     * from a runtime stack.
     */
    configPath: string
    /** Whether module files are auto-discovered and merged. Default true. */
    automerge: boolean
    /** Declared env variables and their requirements. */
    env: Record<string, { required: boolean; description?: string }>
    /** Declared options schema, keyed by option name. */
    optionsSchema: Record<string, ModuleOptionSchema>
    /** Resolved options from axon.config.ts, validated against optionsSchema. */
    options?: Record<string, unknown>
    /** Absolute path to modules/<name>/server/, when present. */
    serverPath?: string
    /** Absolute path to modules/<name>/server/api/, when present. */
    apiPath?: string
    /** Absolute path to modules/<name>/data/knowledge/, when present. */
    knowledgePath?: string
    /**
     * Why this module loaded WITHOUT part of what it declares.
     *
     * Set when a scanner could not read something the module ships — tools
     * that will not compile, a prompt that would not introspect. The module is
     * still installed and still in the blueprint; some of its surface is
     * missing.
     *
     * Present on the module rather than only in a warnings list because the
     * MODEL has to be told. A tool that failed to declare is absent from
     * <scope> by construction, which is correct but silent: without this the
     * agent has no way to know it lost a capability, and confidently offers
     * one it cannot call. Rendered into context so it can say "I cannot search
     * arXiv right now" instead.
     */
    degraded?: string
    prompts: AxonPrompt[]
    scripts: AxonScript[]
    tools: AxonTool[]
}

/** Maps a ModuleOptionSchema `type` string to its runtime value type. */
export type OptionTypeMap = {
    string: string
    number: number
    boolean: boolean
}

/**
 * Module authoring configuration — the object passed to `defineModule()`
 * in `module.config.ts`.
 */
export type ModuleConfig<
    O extends Record<string, ModuleOptionSchema> = Record<string, ModuleOptionSchema>,
    E extends ModuleEmitMap = ModuleEmitMap,
> = {
    /**
     * Identity — name, version, description — lives in package.json, not
     * here. It is what the registry publishes, what `bun install` resolves,
     * and what the module list renders; a second copy in this file could
     * only ever disagree with it. Both fields were declared here and read
     * by nothing, so a module that set them looked configured and wasn't.
     *
     * This config is for BEHAVIOUR: env, policy, options, hooks, setup.
     */
    /** Environment variables this module expects the host agent to provide. */
    env?: Record<string, { required: boolean; description?: string }>
    /**
     * Event payloads this module may emit. Declared inline as `{} as { ... }`;
     * the payload types are PRESERVED through the `E` generic (not widened to
     * unknown), so typegen can recover them via `typeof Module.emits` and give
     * subscribers typed payloads at `axon.hooks.hook("event", ...)`.
     */
    emits?: E
    /** Advisory sandbox permissions this module needs. */
    policy?: ModulePolicyNeeds
    /** User-configurable options accepted under `modules.<name>` in `axon.config.ts`. */
    options?: O
    /**
     * Boot-time setup, run by the core runtime when the agent boots. Receives
     * a narrow `axon` handle (hooks, env, policy) and the module's validated
     * options. This is the ONE place a module registers behaviour: lifecycle
     * hooks go through `ctx.axon.hook(...)`, not a separate declarative field.
     * Runs again on hot-reload, after the previous setup's disposers.
     */
    setup?: (ctx: ModuleSetupCtx<InferOptions<O>>) => void | Promise<void>
    /**
     * Sub-modules this module depends on. Flattened and prepended before the agent's
     * own module list at manifest generation time. First declaration wins on collision.
     */
    modules?: ModuleEntry[]
}

/** Event payloads a module may emit. */
export type ModuleEmitMap = Record<string, unknown>


/** Context object passed to a module's `setup()` function. */
export type ModuleSetupCtx<O extends Record<string, unknown> = Record<string, unknown>> = {
    /** Boot-time module setup handle. */
    axon: ModuleSetupAxon
    /** Validated module options resolved from the agent config. */
    options: O
}

/** Return shape produced by `defineModule()`. */
export type ModuleDefinition = {
    _kind: "module"
    config: ModuleConfig
}

/**
 * Derives a typed options object from a Record<string, ModuleOptionSchema>.
 * Required options are non-optional. Everything else is optional.
 */
export type InferOptions<O extends Record<string, ModuleOptionSchema>> =
    { [K in keyof O as O[K]["required"] extends true ? K : never]: OptionTypeMap[O[K]["type"]] } &
    { [K in keyof O as O[K]["required"] extends true ? never : K]?: OptionTypeMap[O[K]["type"]] }

/**
 * Schema entry for a module option.
 *
 * Module options are declared by `defineModule()` and configured by agents under
 * `modules.<moduleName>`. The schema is intentionally small so the CLI can validate
 * options and generate simple forms.
 *
 * ```ts
 * options: {
 *     owner: { type: "string", required: true },
 *     retries: { type: "number", default: 3 },
 *     dryRun: { type: "boolean", default: false },
 * }
 * ```
 */
export type ModuleOptionSchema = {
    /** Primitive option type accepted by the generated config validator. */
    type: "string" | "number" | "boolean"
    /** Default value used when the agent does not configure this option. */
    default?: unknown
    /** Optional set of accepted values. */
    enum?: unknown[]
    /** Whether the agent must provide this option. */
    required?: boolean
    /** Human-readable help text shown by config and install tooling. */
    description?: string
}
/**
 * A module entry in `defineAgent({ modules })` or `defineModule({ modules })`.
 *
 * Three forms are accepted:
 * - `"@axon/telegram"` — registry module, auto-installed at prepare time
 * - `TelegramModule` — source import, used directly (no install step)
 * - `[TelegramModule, { mentionOnly: true }]` — either form with options
 */
export type ModuleEntry<O extends Record<string, ModuleOptionSchema> = Record<string, ModuleOptionSchema>> =
    | string
    | ModuleConfig<O>
    | [string, Record<string, unknown>]
    | [ModuleConfig<O>, Record<string, unknown>]

/**
 * Narrow runtime handle available inside `ModuleConfig.setup()`.
 *
 * This boot-time handle lets modules register hooks, update policy, add server
 * routes, and inspect module tools without exposing the full agent conversation API.
 */
export type ModuleSetupAxon = {
    /** Register a lifecycle or custom hook handler. */
    hook(name: string, handler: (...args: any[]) => void | Promise<void>): void
    /** Emit a hook — fires all registered handlers for this name. */
    callHook(name: string, ...args: any[]): Promise<void>
    /**
     * Deliver a stimulus — the sense door, for modules that ARE sense organs.
     *
     * A channel module (Telegram, Discord, Slack) holds a live transport for
     * the agent's whole life and pushes what it receives into the session:
     *
     * ```ts
     * axon.stim("cognet:stimulus:text", {
     *     channel: "telegram:123456789",
     *     content: "cody: did the deploy finish?",
     * })
     * ```
     *
     * Granted here, unlike `request`/`stream`, because sensing is not
     * cognition. A stimulus is raw sense data — nothing upstream of the brain
     * may judge, rank, or filter it (see stimuli.ts) — so this hands a module
     * no cognitive power, only a wire into the session. The mind still decides
     * when to wake and what to attend to.
     *
     * The counterpart is the module's TOOL surface: sense in through `stim`,
     * act out through a tool the brain calls deliberately.
     */
    stim<K extends AxonStimulusType>(type: K, data: AxonStimulusEvent[K]): Promise<AxonEntry>
    /**
     * Register teardown for this module's live resources (connections, timers,
     * sockets). Disposers run in REVERSE module order on shutdown, and on
     * hot-reload before setup re-runs — so a reloaded agent is identical to a
     * freshly-booted one. Call it once per resource; they run in reverse
     * registration order within the module too.
     */
    onDispose(fn: () => void | Promise<void>): void
    /**
     * Report that this module is installed but not working, and let the agent
     * boot anyway.
     *
     * The alternative is throwing, and a throw in setup() is TOTAL — no later
     * module is wired and the agent does not come up. That is the right answer
     * for a module that is broken. It is the wrong answer for one that is
     * merely unconfigured: a channel whose credential has not been pasted yet
     * should leave the agent running with one sense organ unconnected, not
     * take the whole agent down. An unbootable agent also cannot run the
     * command that would fix it.
     *
     * Renders as a warning rather than an error — "the agent is fine EXCEPT
     * for the thing you just installed" — and repeats on each boot until the
     * cause is resolved, because a one-time notice about a permanent gap is
     * one the user will not see again when they wonder why nothing happens.
     */
    warn(message: string): Promise<void>
    env: {
        get(key: string): string | undefined
        require(key: string): string
    }
    policy: {
        update(patch: Record<string, unknown>): void
    }
    server: {
        addRoute(method: string, path: string, handler: (...args: any[]) => any): void
        addMiddleware(handler: (...args: any[]) => any): void
    }
    tools: {
        get(name: string): unknown
    }
}

/**
 * Advisory policy requirements declared by a module.
 *
 * The CLI uses these during install to patch or suggest entries in the agent's
 * `policy`. Runtime enforcement still comes from the final agent policy.
 */
export type ModulePolicyNeeds = {
    network?: { needs: string[] }
    fs?: { read?: string[]; write?: string[] }
}

