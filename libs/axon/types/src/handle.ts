import type { AxonEntry, AxonKernelEvent, AxonSessionEvent } from "./session"
import type { AxonScript } from "./scripts"
import type { AxonPrompt } from "./prompts"
import type { AxonPartialBlueprint } from "./blueprint"
import type { AxonHookName, AxonHooks, AxonModuleEvents } from "./hooks"
import type { AxonAmbient } from "./session/events/activity"

/**
 * Cross-package contracts for the new runtime.
 *
 * Only seams that more than one package depends on live here:
 * - AxonHandle       — what agent code sees (globalThis.axon, plugins, scripts)
 * - EngineConnection — what @axon/cloud hands @axon/core for inference
 *
 * Intra-core handles (session, capsule manager, server) are
 * `ReturnType<typeof X>` inside @axon/core — they are not contracts.
 */

// ── Engine connection (implemented by @axon/cloud, consumed by @axon/core) ───

/** Input to a single agent invocation. */
export type AxonRequestInput = {
    /** One stimulus, or an ordered batch committed before a single wake. */
    prompt: string | string[]
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
 * contract (the implementation type lives in @axon/capsule; this is what
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

export type EngineDelegate = {
    /** Tool execution target. Absent/undefined = no capsule attached; capsule RPCs reject loudly. */
    capsule?: () => CapsuleDelegate | undefined
    /** Prompt template renderer — backs Cognos's prompt.render RPC. */
    prompt?: (name: string, props?: Record<string, unknown>) => Promise<string>
}

/**
 * A live connection to a Cognos engine. @axon/cloud owns how this is
 * established (ws3, auth, engine resolution); @axon/core only ever
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
    /** Render a prompt by name. Static .md returns as-is; dynamic .vue renders with props. */
    prompt(name: string, props?: Record<string, unknown>): Promise<string>

    /** Prompt enumeration — every prompt the blueprint declares. Rendering stays on `prompt(name)`. */
    prompts: {
        list(): AxonPrompt[]
    }

    /** One-shot agent invocation. */
    request(input: AxonRequestInput | string): Promise<AxonResult>

    /** Streaming agent invocation — yields entries as they happen. */
    stream(input: AxonRequestInput | string): AxonRun

    scripts: {
        request(name: string, args?: Record<string, unknown>): Promise<unknown>
        list(): AxonScript[]
    }

    /** Installed tool namespaces, callable by name — each call is a mediated capsule request. */
    tools: Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>

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
