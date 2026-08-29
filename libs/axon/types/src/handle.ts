import type { EscalationCall } from "./policy"
import type { AxonEntry, AxonKernelEvent, AxonSessionEvent, AxonStimulusEvent, AxonStimulusType } from "./session"
import type { AxonOutputEvent } from "./session/events/stdio/output"
import type { AxonScript } from "./scripts"
import type { AxonPrompt, AxonPromptName, AxonPromptProps } from "./prompts"
import type { AxonPartialBlueprint } from "./blueprint"
import type { AxonHookName, AxonHooks, AxonModuleEvents } from "./hooks"
import type { AxonAmbient } from "./session/events/activity"

/**
 * Cross-package contracts for the new runtime.
 *
 * Only seams that more than one package depends on live here:
 * - AxonHandle       — what agent code sees (globalThis.axon, plugins, scripts)
 * - EngineConnection — what @axon/cloud hands @arcforge/core for inference
 *
 * Intra-core handles (session, capsule manager, server) are
 * `ReturnType<typeof X>` inside @arcforge/core — they are not contracts.
 */

// ── Engine connection (implemented by @axon/cloud, consumed by @arcforge/core) ───

/** Input to a single agent invocation. */
export type AxonRequestInput = {
    /** One stimulus, or an ordered batch committed before a single wake. */
    prompt: string | string[]
    /**
     * The surface this message arrived on — and the address a reply goes back
     * to. `terminal`, `axon-cli`, `telegram:8199237521`.
     *
     * Supplied by the host, because the runtime cannot know which surface it
     * is embedded in. A channel module reaching the agent names its own line
     * the same way, which is what lets the agent answer on the line it was
     * asked. Defaults to `terminal`.
     */
    channel?: string
    /**
     * The shape this response must have, as a TypeScript type.
     *
     *   output: "{ files: number, issues: { file: string }[] }"
     *   output: "type Issue = { file: string }\ntype Output = { issues: Issue[] }"
     *
     * Either a type expression, or declarations whose target is named
     * `Output` — the second form is how a recursive or shared shape is
     * expressed. TypeScript rather than a schema library because the agent's
     * whole model-facing surface is already TypeScript declarations: the
     * model sees its target in the same language as its tools, and there is
     * nothing new for anyone to learn or install.
     *
     * Checked before the model is called (an invalid type throws at the call
     * site, costing no inference), rendered into the model's context, and
     * enforced against the script it writes. A mismatch returns to the model
     * as a real TypeScript diagnostic — which it repairs far more reliably
     * than schema-validator prose.
     */
    output?: string
    /**
     * Further attempts allowed after a response fails its `output` check.
     * Defaults to 2, so a request makes at most 3 model calls. On
     * exhaustion the invocation throws with the accumulated diagnostics —
     * it never returns a response that does not satisfy the contract.
     *
     * Ignored when `output` is absent: there is nothing to fail.
     */
    retries?: number
}

/** Result of a completed agent invocation. */
export type AxonResult = {
    /** Final response text. */
    text: string
    /** Entries appended during this invocation, in order. */
    entries: AxonEntry[]
}

/** One live invocation. Cancellation is scoped to this exact wake. */
export type AxonRun = {
    stream: AsyncGenerator<AxonEntry, void, undefined>
    /** Request cancellation. Returns immediately; teardown completes on the stream. */
    interrupt(): void
}

/**
 * What core hands cloud for Cognos to call back into mid-loop. All fields
 * are lazy getters — the capsule boots after the connection is constructed,
 * and the connection dials lazily anyway.
 */
/**
 * The capsule surface an engine delegate may drive — hand-written seam
 * contract (the implementation type lives in @arcforge/capsule; this is what
 * the wire actually needs: execute + cancel).
 */
export type CapsuleDelegate = {
    run(code: string, opts?: { timeoutMs?: number }): Promise<unknown>
    interrupt(): void
}

/**
 * The embedding host an agent can call back into — a TUI, a server, another
 * agent. Absent when nothing is hosting this runtime.
 *
 * Lives here rather than beside the composition root because the KERNEL takes
 * it as an injected collaborator: a type owned by Axon() would make ring 0
 * import its own composition root, which becomes a circular package dependency
 * the moment the kernel is extracted.
 */
export type AxonHost = {
    call(request: {
        callerSessionId: string
        method: string
        input: unknown
        signal: AbortSignal
    }): Promise<unknown>
}

/**
 * The platform's answer to a capsule's "may I?".
 *
 * Deliberately NOT a method on AxonHost. That is the GUEST-facing channel —
 * sandboxed code calls through it — and a guest able to invoke the policy
 * decider could raise its own escalations, or answer them. This is host-side
 * code asking host-side code, on the trusted side of the same boundary the
 * mediator enforces.
 *
 * Absent means no decider, which the capsule already treats as deny. That is
 * the honest state for a headless run and for any embedder that never wired
 * one.
 */
export type AxonEscalate = (call: EscalationCall) => Promise<boolean>

export type EngineDelegate = {
    /** Tool execution target. Absent/undefined = no capsule attached; capsule RPCs reject loudly. */
    capsule?: () => CapsuleDelegate | undefined
    /** Prompt template renderer — backs Cognos's prompt.render RPC. */
    prompt?: (name: string, props?: Record<string, unknown>) => Promise<string>
}

/**
 * A live connection to a Cognos engine. @axon/cloud owns how this is
 * established (ws3, auth, engine resolution); @arcforge/core only ever
 * dispatches through it. Deliberately Cognos-agnostic — this type is the
 * open-source boundary and must never leak ws3/Cognos internals.
 */
export type EngineConnection = {
    request(input: AxonRequestInput): Promise<AxonResult>
    stream(input: AxonRequestInput): AsyncGenerator<AxonEntry, void, undefined>
    /** Hot reload — re-project the blueprint and push the refreshed surface to Cognos. */
    update(blueprint: import("./blueprint").AxonBlueprint): Promise<void>
    disconnect(): Promise<void>
}

// ── Lifecycle hooks surface ────────────────────────────────────────────────────

/** Handler for a module domain event — receives the module's declared payload. */
export type AxonModuleEventHandler<N extends keyof AxonModuleEvents> =
    (payload: AxonModuleEvents[N]) => void | Promise<void>

/**
 * The hooks surface exposed on AxonHandle — register-only. Firing (`callHook`)
 * is runtime-internal; agent code and plugins only ever register.
 *
 * Two families, one `hook()`:
 *   - Runtime LIFECYCLE hooks (AxonHooks) — a fixed, closed set, function-typed.
 *   - Module domain EVENTS (AxonModuleEvents) — open, augmented per-agent by
 *     typegen from installed modules' `emits`, so `hook("discord:message.received",
 *     ({ content }) => ...)` is fully typed with no imports.
 */
export type AxonHooksSurface = {
    hook<N extends AxonHookName>(name: N, fn: AxonHooks[N]): () => void
    hook<N extends keyof AxonModuleEvents>(name: N, fn: AxonModuleEventHandler<N>): () => void
    removeHook<N extends AxonHookName>(name: N, fn: AxonHooks[N]): void
    removeHook<N extends keyof AxonModuleEvents>(name: N, fn: AxonModuleEventHandler<N>): void
}

// ── AxonHandle ────────────────────────────────────────────────────────────────

/**
 * The runtime handle agent code programs against — injected as the `axon`
 * global inside scripts, handed to plugins and module setup. This is the
 * user surface: anything on it is public API.
 *
 * No thread concept: one Axon() instance is always exactly one continuous
 * stream. Multiple independent conversations are multiple Axon() instances,
 * a host-level (TUI) concern this handle has no opinion on.
 */
export type AxonHandle = {
    /**
     * Whether the agent can currently think — a cognet is loaded and wakeable.
     *
     * False when the brain failed to load, or a hot reload replaced it with
     * one that would not compile. The process stays up and keeps serving in
     * that state (routes and plugins are unaffected), which is why this is
     * exposed rather than inferred from liveness: an agent with no mind
     * answers every health check happily and every request with nothing.
     */
    readonly ready: boolean

    /**
     * Render a prompt by name. Static .md returns as-is; dynamic .vue
     * renders with props.
     *
     * Generic over `AxonPromptMap`, which `axon prepare` fills in with one
     * entry per prompt the agent declares — so a name that does not exist is
     * a compile error, and props are checked against the prompt that will
     * actually receive them.
     */
    prompt<K extends AxonPromptName>(name: K, props?: AxonPromptProps<K>): Promise<string>

    /**
     * This agent's installed modules, as configured.
     *
     * The door a MODULE PLUGIN reads its own options through. A module's
     * `server/plugins/` is merged into the agent's, so its plugin receives
     * this same handle — but a plugin file has no idea which module shipped
     * it and no way to reach the options the agent wrote for it. Without
     * this, a hardware module could open a device but never be told WHICH
     * device, which is the entire configuration surface of a sensor.
     *
     * ```ts
     * // modules/mouse/server/plugins/mouse.ts
     * const { hz = 20 } = axon.modules.options<{ hz?: number }>("mouse")
     * ```
     *
     * Read-only and already validated against the module's declared
     * `optionsSchema` — a plugin gets what the agent configured or the
     * declared default, never a raw config bag.
     */
    modules: {
        /** Every installed module's name, in declaration order. */
        list(): string[]
        /**
         * Validated options for one module. Empty object when the module is
         * installed and configured nothing; THROWS when no such module is
         * installed, because a plugin asking for options by a name that is
         * not there is a wiring mistake and silence would hide it.
         *
         * Returns the FIRST instance when a module is listed several times.
         * A plugin that can serve multiple devices reads `all()` instead.
         */
        options<T extends Record<string, unknown> = Record<string, unknown>>(name: string): T
        /**
         * Every instance's options, in declaration order.
         *
         * An agent may list one module several times to attach it to several
         * devices — two screens, two cameras, two microphones:
         *
         * ```ts
         * modules: [
         *     [Screen, { output: "DP-2" }],
         *     [Screen, { output: "DP-0" }],
         * ]
         * ```
         *
         * The module's code is scanned and its plugin runs ONCE; this is how
         * that one run learns it has two devices to open. The platform
         * deliberately invents no identity for the copies — what
         * distinguishes two screens is the output name, and only the module
         * knows that, so it derives its own channels from these options.
         *
         * Always at least one entry for an installed module (an unconfigured
         * instance is `{}`); throws for a module that is not installed, for
         * the same reason `options()` does.
         */
        all<T extends Record<string, unknown> = Record<string, unknown>>(name: string): T[]
    }

    /** Prompt enumeration — every prompt the blueprint declares. Rendering stays on `prompt(name)`. */
    prompts: {
        list(): AxonPrompt[]
    }

    /** One-shot agent invocation. */
    request(input: AxonRequestInput | string): Promise<AxonResult>

    /** Streaming agent invocation — yields entries as they happen. */
    stream(input: AxonRequestInput | string): AxonRun

    /**
     * Deliver a stimulus — the agent's sense door, and the only way the
     * environment reaches cognition.
     *
     * ```ts
     * axon.stim("cognet:stimulus:vector", {
     *     channel: "light",
     *     values: [0.42, 0.38],
     *     unit: "lux",
     *     labels: ["left", "right"],
     * })
     * ```
     *
     * The stimulus lands on the delivery buffer and is handed to the cognet
     * at its next wake, then dropped — a stimulus is a transient sensation,
     * not a record. A cognet gets ONE chance to attend to it; anything it
     * wants to keep, it keeps in its own resident state. Nothing here judges
     * what is worth delivering (see stimuli.ts — zero cognition upstream of
     * the brain), so a producer emits what its sensor produced and lets the
     * mind decide what matters.
     *
     * Mirrors `kernel.output(type, data)` on the far side of the boundary:
     * sense in, act out, same shape.
     */
    stim<K extends AxonStimulusType>(type: K, data: AxonStimulusEvent[K]): Promise<AxonEntry>

    /**
     * Observe what the brain emits — the counterpart to `stim()`.
     *
     * ```ts
     * // server/plugins/speaker.ts
     * axon.on("cognet:output:audio", async ({ ref }) => play(ref))
     * ```
     *
     * A body could always send sensations IN and never see what came OUT. The
     * asymmetry was invisible while every effect was a tool call — those reach
     * the body through the capsule — but `kernel.output()` is the unmediated
     * door, and nothing downstream could listen at it. A cognet that speaks
     * had no way to be heard.
     *
     * Typed against the OUTPUT protocol only, not the whole entry vocabulary.
     * Stimuli are the body's own input and it does not need to observe what it
     * sent; actions already arrive as tool calls. What was missing is exactly
     * this: the four kinds a mind emits.
     *
     * The brain is never told whether anyone listened, and must not be. That
     * is what lets the same cognet run in a body with a speaker, a body with a
     * WebRTC track, and a body with neither — emitting identically in all
     * three. A handler that throws is logged and swallowed for the same
     * reason: a broken speaker is not the mind's problem, and an emission that
     * already committed cannot be un-emitted.
     *
     * Returns an unsubscribe.
     */
    on<K extends keyof AxonOutputEvent>(
        type: K,
        handler: (data: AxonOutputEvent[K]) => void | Promise<void>,
    ): () => void

    // There is deliberately no tick()/wake() here. A body emits stimuli and
    // never decides when the brain looks at them:
    //
    //   ```ts
    //   // server/plugins/body.ts — sense, unconditionally
    //   setInterval(async () => {
    //       world.step(dt)
    //       await axon.stim("cognet:stimulus:vector", { ... })
    //   }, 16)
    //   ```
    //
    // How fast frames arrive is a property of a sensor. How often it is worth
    // thinking about them is a property of a mind — so the brain drives its
    // own rhythm through `kernel.wake()`, from a cognet plugin. That keeps
    // bodies swappable (one that drove a specific brain had to be rewritten
    // whenever the brain changed) and is the only answer that survives
    // composition, where two sensors at different rates have equal claim to
    // being "the" tick.

    scripts: {
        request(name: string, args?: Record<string, unknown>): Promise<unknown>
        list(): AxonScript[]
    }


    /**
     * Hot-reload trigger — apply a blueprint to the live runtime.
     * - mode "merge" (default): partial update; absent fields keep their value.
     * - mode "replace": the blueprint is authoritative (a config-file reload);
     *   absent config fields are dropped, not retained.
     */
    update(partial: AxonPartialBlueprint, opts?: { mode?: "merge" | "replace" }): Promise<void>

    hooks: AxonHooksSurface

    /**
     * The session's identity and its logs, read-only.
     *
     * Reads are a supported surface: `GET /_axon/session` serves these same
     * arrays to any authorized caller, so narrowing them here protected nothing
     * and only made the runtime take a longer path to its own data. A consumer
     * is trusted with its own agent's record — an author deciding what of it to
     * show their own users is an application concern, not a runtime one.
     *
     * Writes stay core-internal. There is no commit path here on purpose: the
     * session is the agent's continuity record, and authored code appending to
     * it directly is how that record gets corrupted. Events reach the log by
     * being emitted on the bus, never by being written.
     */
    session: {
        id: string
        /** The interaction log — what cognition and clients see. */
        readonly entries: readonly AxonEntry[]
        /** Runtime/continuity facts: boot, shutdown, errors. */
        readonly log: readonly AxonSessionEvent[]
        /** Internal tick/phase/system telemetry — the firehose behind devtools and flame graphs. */
        readonly kernelLog: readonly AxonKernelEvent[]
    }
}


/**
 * The honest Axon surface inside a capsule tool. A tool cannot re-enter the
 * Axon instance currently waiting for it, so request() is host-mediated and
 * runs on an isolated child instance.
 */
export type AxonCapsuleHandle = AxonAmbient & {
    request(input: AxonRequestInput | string): Promise<AxonResult>
}
