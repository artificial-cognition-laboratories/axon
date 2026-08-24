import { err } from "@arcforge/err"
import type {
    AxonBlueprint,
    AxonEngineDriver,
    AxonEngineEvent,
    AxonEngineRequest,
    AxonEngineResponse,
    EngineCloud,
} from "@arcforge/types"
import { asEngineFault, EngineFailure, resolveEngine } from "@arcforge/engines"
import { Air, type AirBlockEvent } from "@arcforge/cognet/air"
import type { AxonSessionT } from "@arcforge/session"

type EngineOpts = {
    blueprint: AxonBlueprint
    session: AxonSessionT
    /** The runtime's cloud client — handed to drivers at create(); engines call what they need. */
    cloud: EngineCloud
}

type EngineContext = {
    runId: string
}

const MAX_ATTEMPTS = 3
const RETRY_DELAYS_MS = [100, 300] as const

/**
 * Engine — the inference layer of the runtime. Drivers are raw token pipes;
 * this manager owns AIR parsing, bounded pre-output retries, and the durable
 * accounting span around every logical call.
 *
 * A retry is deliberately invisible to cognition only while an attempt has
 * produced no raw delta. Once any text or thinking has crossed the boundary,
 * retrying could duplicate semantic output, so that failure is terminal.
 */
export function Engine(opts: EngineOpts) {
    const air = Air()
    let blueprint = opts.blueprint
    let current = build(blueprint)

    function build(blueprint: AxonBlueprint): { driver: AxonEngineDriver; name: string } | null {
        if (!blueprint.config.engine) return null
        const def = resolveEngine(blueprint.config.engine)
        return { driver: def.create({ env: blueprint.env, cloud: opts.cloud }), name: def.name }
    }

    async function* stream(req: AxonEngineRequest, context: EngineContext): AsyncGenerator<AxonEngineEvent> {
        const span = { ...context, spanId: Bun.randomUUIDv7() }
        // The whole logical call, retries and AIR parsing included — distinct
        // from meta.durationMs, which is one attempt's provider latency. A
        // call that succeeded on its third try shows both numbers honestly.
        const callStarted = Date.now()
        if (!current) {
            const fault = {
                code: "INVALID_REQUEST" as const,
                message: "NO_ENGINE: blueprint.config.engine is not configured",
                retryable: false,
                provider: "unconfigured",
            }
            await opts.session.commit("kernel:engine:start", { provider: fault.provider }, span)
            await opts.session.commit("kernel:engine:input", {
                messages: req.messages,
                bytes: new TextEncoder().encode(JSON.stringify(req.messages)).byteLength,
            }, span)
            await opts.session.commit("kernel:engine:failed", { attempts: 0, fault, durationMs: Date.now() - callStarted }, span)
            throw err("ENGINE_MISSING")
        }

        const selected = current
        const configuredEngine = blueprint.config.engine
        const model = req.model ?? (configuredEngine && "model" in configuredEngine ? configuredEngine.model : undefined)
        const correlation = model ? { provider: selected.name, model } : { provider: selected.name }

        await opts.session.commit("kernel:engine:start", correlation, span)
        await opts.session.commit("kernel:engine:input", {
            messages: req.messages,
            bytes: new TextEncoder().encode(JSON.stringify(req.messages)).byteLength,
        }, span)

        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            const parser = air.parser()
            let semanticOutputSeen = false
            let doneSeen = false
            const started = Date.now()
            let firstTokenAt: number | undefined
            // What the parser actually saw, streamed. Some drivers (Codex)
            // additionally emit an authoritative text:final that silently
            // overwrites the response text without ever re-crossing the
            // parser (see Collect()) — if that final text disagrees with
            // what was streamed, the parser's incompleteness judgment was
            // made against data that was never the real, final output. On
            // `done`, reconcile: re-parse the authoritative text fresh
            // rather than trust a parser that only ever saw a divergent
            // stream.
            let streamedText = ""

            try {
                for await (const raw of selected.driver.stream(req)) {
                    if (raw.type !== "done") {
                        firstTokenAt ??= Date.now()
                    }
                    if (raw.type === "text:delta" && raw.content.trim()) semanticOutputSeen = true

                    switch (raw.type) {
                        case "text:delta":
                            // Track exactly what crossed as deltas so the
                            // `done` reconciliation can tell a missing tail
                            // (extend) from a full re-feed (which would
                            // double-fire every already-streamed block).
                            streamedText += raw.content
                            for (const block of parser.feed(raw.content)) {
                                const event = toBlockEvent(block)
                                if (event) yield event
                            }
                            break

                        case "thinking:delta":
                            // dropped at the boundary — thinking never crosses the wire
                            break

                        case "done": {
                            if (doneSeen) {
                                throw protocolFailure(selected.name, model, "driver emitted more than one done event")
                            }
                            doneSeen = true
                            if (!semanticOutputSeen && raw.response.text.trim().length === 0) {
                                throw new EngineFailure({
                                    code: "EMPTY_RESPONSE",
                                    message: `empty response from model \"${raw.response.meta.model}\"`,
                                    retryable: true,
                                    provider: selected.name,
                                    model: raw.response.meta.model,
                                })
                            }
                            // Some drivers report an authoritative final text
                            // that carries more than what actually crossed as
                            // deltas (e.g. Codex's output_text.done can trail
                            // the last output_text.delta). Feed the missing
                            // suffix into the SAME parser before flush() — it
                            // already emitted blocks from streamedText, so
                            // this must extend, never restart, or already-
                            // committed blocks would double-fire. Only safe
                            // when response.text is a strict extension of
                            // what was streamed; a genuine mismatch (not just
                            // a missing tail) is left to fail honestly rather
                            // than risk reconciling against the wrong content.
                            if (extendsStreamedText(streamedText, raw.response.text)) {
                                const missing = raw.response.text.slice(streamedText.length)
                                if (missing.length > 0) {
                                    for (const block of parser.feed(missing)) {
                                        const event = toBlockEvent(block)
                                        if (event) yield event
                                    }
                                }
                            }
                            for (const block of parser.flush()) {
                                const event = toBlockEvent(block)
                                if (event) yield event
                            }

                            const meta = {
                                ...raw.response.meta,
                                durationMs: raw.response.meta.durationMs || Date.now() - started,
                                ...(raw.response.meta.firstTokenMs === undefined && firstTokenAt !== undefined
                                    ? { firstTokenMs: firstTokenAt - started }
                                    : {}),
                            }
                            const response = { ...raw.response, meta }
                            await opts.session.commit("kernel:engine:complete", {
                                attempts: attempt,
                                text: response.text,
                                ...(response.thinking ? { thinking: response.thinking } : {}),
                                stopReason: response.stopReason,
                                meta,
                                durationMs: Date.now() - callStarted,
                            }, span)
                            yield { type: "engine:done", response }
                            return
                        }
                    }
                }

                if (!doneSeen) {
                    throw protocolFailure(selected.name, model, "driver stream ended without a done event")
                }
            } catch (error) {
                // Cancellation is control flow, not an engine fault. Drivers
                // vary in what they throw on abort (DOMException, plain Error,
                // or a transport wrapper), so the request signal is the one
                // authoritative source. Wake() records kernel:run:interrupted
                // and closes the wire; emitting engine:failed here would turn
                // an intentional Escape/Ctrl+C into AX-KERNEL-008.
                if (req.signal?.aborted) throw abortError(req.signal)

                const fault = asEngineFault(error, correlation)
                const canRetry = fault.retryable && !semanticOutputSeen && !req.signal?.aborted && attempt < MAX_ATTEMPTS

                if (canRetry) {
                    const suggestedDelay = fault.retryAfterMs ?? RETRY_DELAYS_MS[attempt - 1] ?? RETRY_DELAYS_MS.at(-1)!
                    const delayMs = Math.min(suggestedDelay, 5_000)
                    await opts.session.commit("kernel:engine:retry", {
                        attempt,
                        nextAttempt: attempt + 1,
                        delayMs,
                        fault,
                    }, span)
                    try {
                        await delay(delayMs, req.signal)
                    } catch (delayError) {
                        // Same rule as the outer catch above: an interrupt
                        // landing during retry backoff is cancellation, not
                        // an engine fault — the signal is authoritative, not
                        // whatever delay() happened to throw.
                        if (req.signal?.aborted) throw abortError(req.signal)

                        const abortFault = asEngineFault(delayError, correlation)
                        await opts.session.commit("kernel:engine:failed", { attempts: attempt, fault: abortFault, durationMs: Date.now() - callStarted }, span)
                        throw err("ENGINE_STREAM_FAILED", {
                            detail: abortFault.message,
                            context: { code: abortFault.code, provider: abortFault.provider, model: abortFault.model, retryable: abortFault.retryable, attempts: attempt },
                            cause: delayError,
                        })
                    }
                    continue
                }

                await opts.session.commit("kernel:engine:failed", { attempts: attempt, fault, durationMs: Date.now() - callStarted }, span)
                if (fault.code === "AUTH_NOT_CONNECTED" && fault.provider === "codex") {
                    throw err("CODEX_NOT_CONNECTED", {
                        detail: fault.message,
                        context: { provider: fault.provider, model: fault.model, attempts: attempt },
                        cause: error,
                    })
                }
                throw err("ENGINE_STREAM_FAILED", {
                    detail: fault.message,
                    context: { code: fault.code, provider: fault.provider, model: fault.model, retryable: fault.retryable, attempts: attempt },
                    cause: error,
                })
            }
        }
    }

    return {
        get configured() {
            return current !== null
        },

        stream: stream,

        async request(req: AxonEngineRequest, context: EngineContext): Promise<AxonEngineResponse> {
            for await (const event of stream(req, context)) {
                if (event.type === "engine:done") return event.response
            }
            throw err("ENGINE_NO_DONE")
        },

        update(next: AxonBlueprint) {
            const nextCurrent = build(next)
            // Assign after build succeeds: a bad engine ref never corrupts
            // either the known-good driver or its metadata source.
            current = nextCurrent
            blueprint = next
        },
    }
}

export type AxonEngineT = ReturnType<typeof Engine>

/** True when `final` is `streamed` plus a non-empty trailing suffix — never a divergence, only a possibly-truncated stream catching up to the provider's authoritative text. */
function extendsStreamedText(streamed: string, final: string): boolean {
    return final.length > streamed.length && final.startsWith(streamed)
}

function protocolFailure(provider: string, model: string | undefined, message: string): EngineFailure {
    return new EngineFailure({
        code: "PROTOCOL",
        message,
        retryable: true,
        provider,
        ...(model ? { model } : {}),
    })
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortError(signal))
    return new Promise((resolve, reject) => {
        const timer = setTimeout(done, ms)
        function done() {
            signal?.removeEventListener("abort", aborted)
            resolve()
        }
        function aborted() {
            clearTimeout(timer)
            reject(abortError(signal))
        }
        signal?.addEventListener("abort", aborted, { once: true })
    })
}

function abortError(signal?: AbortSignal): DOMException {
    return new DOMException(signal?.reason ? String(signal.reason) : "engine request aborted", "AbortError")
}

function toBlockEvent(block: AirBlockEvent): AxonEngineEvent | null {
    switch (block.type) {
        case "text:delta":
            return { type: "engine:text:delta", content: block.content }
        case "thinking:delta":
            return null // dropped — thinking never crosses the wire

        case "text:done":
            if (block.incomplete) return incomplete("text", block.content)
            return { type: "engine:text", content: block.content }
        case "thinking:done":
            return null // dropped — thinking never crosses the wire
        case "typescript:done":
            if (block.incomplete) return incomplete("typescript", block.content)
            return { type: "engine:typescript", id: Bun.randomUUIDv7(), content: block.content }

        case "shell:done":
            return {
                type: "engine:output:error",
                code: "UNSUPPORTED_BLOCK",
                message: "shell blocks are not executable in this runtime",
                excerpt: block.content.slice(0, 200),
            }

        case "done":
            return { type: "engine:stop" }
    }
}

function incomplete(tag: string, content: string): AxonEngineEvent {
    return {
        type: "engine:output:error",
        code: "INCOMPLETE_BLOCK",
        message: `stream ended inside an unclosed <${tag}> block`,
        excerpt: content.slice(0, 200),
    }
}
