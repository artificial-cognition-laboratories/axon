/**
 * The slice of the Vercel AI SDK's provider spec this package depends on.
 *
 * ── Why it is spelled here rather than imported ───────────────────────────
 *
 * Same reason `EngineCloud` is hand-written in @arcforge/types: a structural
 * contract at a seam, so nothing above it takes a hard dependency. Here the
 * argument is stronger. `@ai-sdk/provider` is a peer dependency that a user
 * may not have installed — every provider package is optional and lazily
 * imported — and a type-level `import` from a package that may be absent is a
 * build failure for everyone who declined it.
 *
 * A real provider's model satisfies this structurally, so `anthropic("...")`
 * is assignable with no cast. What is NOT here is deliberate: no tools, no
 * tool-call parts, no `doGenerate`. A driver is a dumb token pipe and Cognos
 * owns the loop, so the tool surface of the spec is not something this
 * package should be able to reach even by accident.
 *
 * ── Version ──────────────────────────────────────────────────────────────
 *
 * Written against specification version "v4" (@ai-sdk/provider 4.x). The
 * version is CHECKED at construction rather than assumed: the spec has
 * renamed its stream parts before (v2 carried `textDelta`, v4 carries
 * `delta`), and a silent shape mismatch would surface as an agent that
 * streams nothing rather than as a failure anyone can read.
 */

/** What a `@ai-sdk/*` provider returns for one model id. */
export type SdkLanguageModel = {
    readonly specificationVersion: string
    readonly provider: string
    readonly modelId: string
    doStream(options: SdkCallOptions): PromiseLike<SdkStreamResult>
}

export type SdkCallOptions = {
    prompt: SdkMessage[]
    maxOutputTokens?: number
    temperature?: number
    abortSignal?: AbortSignal
    /** Reasoning effort, when the model exposes one. Ignored by models that do not. */
    reasoning?: "provider-default" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh"
}

/**
 * Only the three roles Axon renders.
 *
 * `tool` is absent by construction: the kernel executes scripts and appends
 * their results to the session as ordinary text, so a tool ROLE never reaches
 * a driver. Spelling it here would invite one.
 */
export type SdkMessage =
    | { role: "system"; content: string }
    | { role: "user"; content: Array<{ type: "text"; text: string }> }
    | { role: "assistant"; content: Array<{ type: "text"; text: string }> }

export type SdkStreamResult = {
    stream: ReadableStream<SdkStreamPart>
}

/**
 * The stream parts this adapter reads.
 *
 * A narrowed view of the spec's union — the parts a text-only, tool-free call
 * can produce, plus `error`, which must never be silently dropped. Unknown
 * part types are ignored by the adapter's switch rather than rejected: the
 * spec adds members (files, sources, tool approvals) and a driver that threw
 * on an unrecognized frame would break on a provider upgrade that changed
 * nothing it uses.
 */
export type SdkStreamPart =
    | { type: "text-delta"; id: string; delta: string }
    | { type: "reasoning-delta"; id: string; delta: string }
    | { type: "response-metadata"; id?: string; modelId?: string }
    | { type: "finish"; finishReason: SdkFinishReason; usage: SdkUsage }
    | { type: "error"; error: unknown }
    | SdkIgnoredPart

/**
 * Frames the adapter reads past.
 *
 * Named individually rather than caught by a `{ type: string }` member: a
 * bare string tag absorbs every literal in the union, so `{ type:
 * "text-delta", delta: "x" }` would widen to it and `delta` would stop being
 * checked — the adapter would typecheck against a shape it does not actually
 * read. (`Exclude<string, "...">` does not help: excluding literals from
 * `string` yields `string` again.)
 *
 * The runtime switch still has a `default` branch, because the spec adds
 * members and a driver must not break on a frame it has never seen. This
 * union is what the adapter KNOWS it can skip; the default is what protects
 * it from the rest.
 */
export type SdkIgnoredPart =
    | { type: "stream-start"; warnings?: unknown[] }
    | { type: "text-start"; id: string }
    | { type: "text-end"; id: string }
    | { type: "reasoning-start"; id: string }
    | { type: "reasoning-end"; id: string }
    | { type: "raw"; rawValue: unknown }

export type SdkFinishReason = {
    unified: "stop" | "length" | "content-filter" | "tool-calls" | "error" | "other"
    raw: string | undefined
}

/**
 * Usage, as the spec reports it.
 *
 * Every count is `number | undefined` upstream, and that is carried rather
 * than defaulted: `AxonEngineMeta.tokens` is documented as absent when the
 * provider does not report usage, NEVER fabricated as zero, because a zero
 * that means "unknown" is indistinguishable from a zero that means "free".
 */
export type SdkUsage = {
    inputTokens: { total: number | undefined; cacheRead?: number | undefined }
    outputTokens: { total: number | undefined; reasoning?: number | undefined }
}
