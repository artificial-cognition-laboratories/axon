import type {
    AxonEngineDriver,
    AxonEngineMeta,
    AxonEngineRawEvent,
    AxonEngineRequest,
    EngineEffort,
} from "@arcforge/types"
import { Collect, failure } from "../shared"
import type { SdkFinishReason, SdkLanguageModel, SdkMessage, SdkStreamPart, SdkUsage } from "./types"

/** The spec version this adapter reads. See ./types.ts. */
const SPEC_VERSION = "v4"

export type AiSdkOptions = {
    /** A model from any `@ai-sdk/*` provider — `anthropic("claude-sonnet-4.6")`. */
    model: SdkLanguageModel
    /** Route name for telemetry and faults — "anthropic", "groq". Ours, not the SDK's. */
    provider: string
    /** Requested reasoning effort. Models without a reasoning control ignore it. */
    effort?: EngineEffort
}

/**
 * One model from a Vercel AI SDK provider, as an Axon driver.
 *
 * The adapter is the whole point of depending on the SDK: it implements one
 * transport and every `@ai-sdk/*` package becomes reachable, so a new provider
 * is a package and a table row rather than an integration.
 *
 * ── What is deliberately NOT used ─────────────────────────────────────────
 *
 * The SDK's `generateText`/`streamText` carry an agent loop — tool dispatch,
 * step control, stop conditions. Those are Cognos's, and calling them would
 * put two loops in one call with neither owning the decision. So this reaches
 * for `doStream` on the model directly, which is the SDK's provider-facing
 * surface: prompt in, deltas out, nothing else. No tools are ever passed.
 */
export function AiSdk(options: AiSdkOptions): AxonEngineDriver {
    // A model built against a different spec revision would stream parts this
    // adapter reads by the wrong field name and yield an agent that emits
    // nothing. Checked at construction, which is where a version mismatch is
    // a wiring error rather than a mysterious empty turn.
    if (options.model.specificationVersion !== SPEC_VERSION) {
        throw failure({
            code: "INVALID_REQUEST",
            message: `ENGINE_SDK_VERSION: ${options.provider} supplied a "${options.model.specificationVersion}" model, but this adapter reads "${SPEC_VERSION}" — align the @ai-sdk/* package with @ai-sdk/provider ${SPEC_VERSION}`,
            retryable: false,
            provider: options.provider,
            model: options.model.modelId,
        })
    }

    const model = options.model
    const provider = options.provider

    return {
        async *stream(req: AxonEngineRequest): AsyncGenerator<AxonEngineRawEvent> {
            const collect = Collect({ provider, model: model.modelId })
            const started = Date.now()

            let firstTokenMs: number | undefined
            let finish: SdkFinishReason | undefined
            let usage: SdkUsage | undefined
            let requestId: string | undefined

            const result = await model.doStream({
                prompt: toPrompt(req.messages),
                ...(req.maxTokens !== undefined ? { maxOutputTokens: req.maxTokens } : {}),
                ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
                ...(req.signal ? { abortSignal: req.signal } : {}),
                ...(options.effort ? { reasoning: options.effort } : {}),
            })

            for await (const part of read(result.stream)) {
                switch (part.type) {
                    case "text-delta": {
                        const delta = (part as { delta: string }).delta
                        if (!delta) break
                        firstTokenMs ??= Date.now() - started
                        yield collect.feed({ type: "text:delta", content: delta })!
                        break
                    }

                    case "reasoning-delta": {
                        const delta = (part as { delta: string }).delta
                        if (!delta) break
                        yield collect.feed({ type: "thinking:delta", content: delta })!
                        break
                    }

                    case "response-metadata":
                        requestId = (part as { id?: string }).id
                        break

                    case "finish":
                        finish = (part as { finishReason: SdkFinishReason }).finishReason
                        usage = (part as { usage: SdkUsage }).usage
                        break

                    // An error frame is TERMINAL and is thrown, never folded
                    // into the text. A provider that fails mid-stream has not
                    // produced a short answer, and letting the deltas so far
                    // stand as a completed turn would hand the kernel a
                    // truncated document it had no way to know was broken.
                    case "error":
                        throw asFault(provider, model.modelId, (part as { error: unknown }).error)

                    // Every other part — files, sources, tool frames, raw
                    // chunks, the text-start/end brackets — carries nothing a
                    // text pipe needs. Ignored rather than rejected: the spec
                    // grows members, and a driver that threw on an unfamiliar
                    // frame would break on an upgrade that changed nothing it
                    // reads.
                    default:
                        break
                }
            }

            yield collect.done({
                ...(req.signal ? { signal: req.signal } : {}),
                ...(finish ? { stopReason: stopReason(provider, model.modelId, finish) } : {}),
                ...(usage ? tokensOf(usage) : {}),
                ...(requestId ? { requestId } : {}),
                ...(firstTokenMs !== undefined ? { firstTokenMs } : {}),
            })
        },
    }
}

/**
 * A web stream, as an async iterable.
 *
 * `ReadableStream` is async-iterable in Node and Bun but NOT in the DOM lib's
 * type (nor in every browser runtime), so `for await` over it either fails to
 * typecheck or relies on a cast that would be a lie somewhere. Reading
 * through the reader is the portable form, and the `finally` matters: a
 * consumer that stops early — an abort, a throw from a later part — must
 * release the lock, or the underlying connection is held until GC.
 */
async function* read<T>(stream: ReadableStream<T>): AsyncGenerator<T> {
    const reader = stream.getReader()
    try {
        while (true) {
            const { done, value } = await reader.read()
            if (done) return
            yield value
        }
    } finally {
        reader.releaseLock()
    }
}

/**
 * Axon messages → the SDK's prompt shape.
 *
 * System messages carry a bare string; user and assistant carry content
 * PARTS. Axon renders one text document per turn, so every non-system message
 * is a single text part — the multi-part shape exists for images and files,
 * which arrive through a different path.
 */
function toPrompt(messages: AxonEngineRequest["messages"]): SdkMessage[] {
    return messages.map(message =>
        message.role === "system"
            ? { role: "system" as const, content: message.content }
            : { role: message.role, content: [{ type: "text" as const, text: message.content }] },
    )
}

/**
 * The SDK's finish reason → Axon's.
 *
 * Axon's vocabulary is three values and each means something the kernel acts
 * on, so the mapping refuses to be lossy in the direction that matters:
 *
 * - `stop`   → "end". The only clean finish.
 * - `length` → "length". The kernel treats trailing blocks as incomplete on
 *   this, so flattening it to "end" would let a half-written AIR block parse
 *   as a finished one — a silent corruption, not a cosmetic loss.
 * - `content-filter` / `error` → THROWN. Neither produced a usable answer,
 *   and both have historically been the shape of a "successful" empty turn.
 * - `tool-calls` → THROWN. We pass no tools, so a model reporting one means
 *   the request was not the one we built.
 * - `other` → "end". Genuinely unknown, and the response is still whatever
 *   the model emitted; the alternative is failing calls that worked.
 */
function stopReason(provider: string, model: string, reason: SdkFinishReason): "end" | "length" {
    switch (reason.unified) {
        case "stop":
        case "other":
            return "end"
        case "length":
            return "length"
        case "content-filter":
            throw failure({
                code: "INVALID_REQUEST",
                message: `${provider}: "${model}" stopped on a content filter${reason.raw ? ` (${reason.raw})` : ""}`,
                retryable: false,
                provider,
                model,
            })
        case "tool-calls":
            throw failure({
                code: "PROTOCOL",
                message: `${provider}: "${model}" reported tool calls, but this driver passes no tools — Cognos owns tool execution`,
                retryable: false,
                provider,
                model,
            })
        case "error":
            throw failure({
                code: "UNKNOWN",
                message: `${provider}: "${model}" stopped with a provider error${reason.raw ? ` (${reason.raw})` : ""}`,
                retryable: true,
                provider,
                model,
            })
    }
}

/**
 * Usage, when the provider reported enough of it to be worth reporting.
 *
 * Absent input OR output means no usage is emitted at all rather than a
 * partial record: `AxonEngineMeta.tokens` requires `in`, `out` and `total`,
 * and inventing a zero for a count the provider never sent is exactly the
 * fabrication the type's comment forbids. `cachedIn` and `reasoning` are
 * genuinely optional and pass through only when present.
 */
function tokensOf(usage: SdkUsage): { tokens?: AxonEngineMeta["tokens"] } {
    const input = usage.inputTokens?.total
    const output = usage.outputTokens?.total
    if (input === undefined || output === undefined) return {}

    const cachedIn = usage.inputTokens?.cacheRead
    const reasoning = usage.outputTokens?.reasoning

    return {
        tokens: {
            in: input,
            out: output,
            total: input + output,
            ...(cachedIn !== undefined ? { cachedIn } : {}),
            ...(reasoning !== undefined ? { reasoning } : {}),
        },
    }
}

/**
 * An SDK error frame or thrown error → an Axon fault.
 *
 * The SDK's error classes carry structured fields (`statusCode`,
 * `isRetryable`) but live in `@ai-sdk/provider`, which this package will not
 * import — see ./types.ts. So the shape is read structurally, and the status
 * code is what drives the code: a 429 is a rate limit whoever threw it.
 */
function asFault(provider: string, model: string, error: unknown): Error {
    if (error instanceof Error && "fault" in error) return error

    const shape = error as { statusCode?: number; isRetryable?: boolean; message?: string }
    const status = typeof shape?.statusCode === "number" ? shape.statusCode : undefined
    const message = shape?.message ?? (error instanceof Error ? error.message : String(error))

    const code = status === 401 || status === 403
        ? "AUTH" as const
        : status === 429
            ? "RATE_LIMIT" as const
            : status === 402
                ? "QUOTA" as const
                : status !== undefined && status >= 400 && status < 500
                    ? "INVALID_REQUEST" as const
                    : status !== undefined && status >= 500
                        ? "TRANSPORT" as const
                        : "UNKNOWN" as const

    return failure({
        code,
        message: `${provider}: ${message}`,
        retryable: shape?.isRetryable ?? (code === "RATE_LIMIT" || code === "TRANSPORT"),
        provider,
        model,
        ...(status !== undefined ? { status } : {}),
        cause: error,
    })
}
