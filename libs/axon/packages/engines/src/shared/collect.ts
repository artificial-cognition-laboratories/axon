import type { AxonEngineMeta, AxonEngineRawEvent } from "@arcforge/types"
import { failure } from "./fault"

/**
 * What a backend leaf yields — the normalized slice of a provider's wire
 * events. `text:final` is for providers that send an authoritative full
 * text at the end (Codex does): it replaces the accumulated deltas in the
 * terminal response and is never re-emitted downstream.
 */
export type EngineDelta =
    | { type: "thinking:delta"; content: string }
    | { type: "text:delta"; content: string }
    | { type: "text:final"; content: string }

type CollectOpts = {
    provider: string
    model: string
}

/**
 * The fold every driver repeats: backend deltas in, raw engine events out,
 * one terminal done. Owns accumulation, the empty-response guard, abort
 * stopReason, and meta assembly — so an engine's stream() is just
 * backend → feed → yield.
 */
export function Collect(opts: CollectOpts) {
    const started = Date.now()
    let thinking = ""
    let output = ""

    return {
        /** Fold one delta. Returns the event to yield downstream — null for silent deltas (text:final). */
        feed(delta: EngineDelta): AxonEngineRawEvent | null {
            switch (delta.type) {
                case "thinking:delta":
                    thinking += delta.content
                    return { type: "thinking:delta", content: delta.content }
                case "text:delta":
                    output += delta.content
                    return { type: "text:delta", content: delta.content }
                case "text:final":
                    // Some providers emit a terminal output_text.done frame
                    // with an absent/empty `text` even after valid deltas.
                    // Empty is not authoritative: never erase output already
                    // observed on the stream.
                    if (delta.content.trim()) output = delta.content
                    return null
            }
        },

        /**
         * The terminal done event. Throws when the model produced nothing —
         * an empty completion is a provider failure, never a valid run.
         * Usage is included only when the provider reports it.
         */
        done(input?: {
            signal?: AbortSignal
            tokens?: AxonEngineMeta["tokens"]
            /**
             * Why the provider stopped, when it says.
             *
             * Absent means "ended normally", which is what every driver
             * written before this parameter existed implies. Passing
             * "length" is how a driver reports TRUNCATION — the kernel
             * treats trailing blocks as incomplete on that signal, and
             * without it a half-written AIR block is parsed as a finished
             * one.
             */
            stopReason?: "end" | "length"
            requestId?: string
            firstTokenMs?: number
        }): AxonEngineRawEvent {
            if (input?.signal?.aborted) {
                throw failure({
                    code: "ABORTED",
                    message: `${opts.provider}: request aborted`,
                    retryable: false,
                    provider: opts.provider,
                    model: opts.model,
                })
            }
            if (!output.trim()) {
                throw failure({
                    code: "EMPTY_RESPONSE",
                    message: `${opts.provider}: empty response from model "${opts.model}"`,
                    retryable: true,
                    provider: opts.provider,
                    model: opts.model,
                })
            }

            return {
                type: "done",
                response: {
                    text: output,
                    ...(thinking ? { thinking } : {}),
                    stopReason: input?.signal?.aborted ? "abort" : (input?.stopReason ?? "end"),
                    meta: {
                        provider: opts.provider,
                        model: opts.model,
                        ...(input?.requestId ? { requestId: input.requestId } : {}),
                        ...(input?.tokens ? { tokens: input.tokens } : {}),
                        durationMs: Date.now() - started,
                        ...(input?.firstTokenMs !== undefined ? { firstTokenMs: input.firstTokenMs } : {}),
                    },
                },
            }
        },
    }
}
