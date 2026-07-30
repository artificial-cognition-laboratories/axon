import type { AxonError } from "../../error"

/**
 * The span convention: every bracketed operation in the runtime declares
 * itself through these helpers, so a family cannot ship a missing half —
 * the triad is generated, not hand-written three times and hoped over.
 *
 * ```
 * <namespace>:<operation>:start        opening facts
 * <namespace>:<operation>:complete     + durationMs
 * <namespace>:<operation>:failed       + error: AxonError
 * <namespace>:<operation>:interrupted  cancellation — never an error
 * ```
 *
 * This is a load-bearing contract, not a naming preference. Two consumers
 * derive meaning from the suffix alone and break silently on a family that
 * invents its own verbs:
 *
 * - The flame graph pairs bars by stripping `:start`/`:complete`/`:failed`
 *   and stack-matching within a run (see apps/fleet's toFlameData). A
 *   family named `loaded`/`spawned`/`restarting` is simply invisible to it.
 * - classifyEvent / isLogEventType read the type namespace and suffix as
 *   the whole classification (envelope.ts rule 3).
 *
 * WHY THIS AND NOT SPAN IDS. Nesting is recovered by bracket-matching, not
 * by a parent pointer: the session is one file with one serialized writer
 * (so disk order IS commit order, and `time.seq` is authoritative), and the
 * scheduler admits one wake at a time. Within a run there is exactly one
 * logical thread of execution, so "what happened inside this span" is
 * exactly "the events between its start and its end, in seq order". That
 * is not an approximation — given one writer and one wake it is exact,
 * which is why `parentSpanId` was removed rather than plumbed (see
 * envelope.ts). `spanId` survives only for operations that genuinely
 * interleave with a concurrent sibling — engine calls today.
 */

/**
 * A bracketed operation: start / complete / failed.
 *
 * `durationMs` is added to BOTH ends here rather than repeated per family,
 * so every span in the system is measurable by construction however it
 * settled. A failed operation still took time, and a reader sizing a bar or
 * hunting a slow path cares about the failures most of all — "the call that
 * blew up after 30s" is a different problem from "the call that blew up
 * instantly".
 *
 * The failure payload DEFAULTS to `{ error: AxonError }` — rule 4 of the
 * envelope, and what a family should want unless it has a specific reason
 * otherwise. Passing `Failed` explicitly REPLACES that default rather than
 * intersecting with it, because the two real exceptions in this system
 * both need to substitute the payload, not extend it:
 *
 * - `kernel:engine:failed` carries `AxonEngineFault` — a richer domain
 *   shape (code, provider, model, retryable) that drives the retry loop.
 * - `kernel:run:failed` carries `{}` — err()'s sink already committed the
 *   canonical error at the throw site; repeating it would log one failure
 *   twice under two names.
 *
 * Substitution rather than extension keeps those honest: the exception is
 * visible at the declaration, not buried as an `error` field nobody fills.
 *
 * @example
 * type Boot = AxonSpan<"axon:boot", { version: string }>
 * // axon:boot:start    { version: string }
 * // axon:boot:complete { durationMs: number }
 * // axon:boot:failed   { error: AxonError }        ← default
 *
 * @example
 * type Engine = AxonSpan<"kernel:engine", {}, {}, { fault: AxonEngineFault }>
 * // kernel:engine:failed { fault: AxonEngineFault } ← substituted
 */
export type AxonSpan<Name extends string, Start = {}, Complete = {}, Failed = { error: AxonError }> =
    & { [K in `${Name}:start`]: Start }
    & { [K in `${Name}:complete`]: Complete & { durationMs: number } }
    & { [K in `${Name}:failed`]: Failed & { durationMs: number } }

/**
 * The fourth state, for operations that can be cancelled.
 *
 * Interruption is a SETTLED OUTCOME, not a failure: a wake ended by Escape,
 * Ctrl+C, or shutdown did what it was told. It must never render as an
 * error, and devtools must never conflate the two — hence a distinct
 * suffix rather than a `reason` discriminant inside `:failed`.
 *
 * Applied at every level cancellation is observable: kernel:run,
 * cognet:tick, cognet:phase, cognet:system, capsule:cmd.
 */
export type AxonInterrupted<Name extends string, P = {}> = {
    [K in `${Name}:interrupted`]: P
}

/** A span that can also be cancelled — the four-state form. */
export type AxonCancellableSpan<Name extends string, Start = {}, Complete = {}, Failed = {}, Interrupted = {}> =
    & AxonSpan<Name, Start, Complete, Failed>
    & AxonInterrupted<Name, Interrupted>

/** The span suffixes, in the one place a suffix-matching reader should derive them from. */
export const SPAN_SUFFIXES = [":start", ":complete", ":failed", ":interrupted"] as const

/** The suffixes that END a span — the closing half of a bracket. */
export const SPAN_END_SUFFIXES = [":complete", ":failed", ":interrupted"] as const

/** True for the opening half of a span bracket. */
export function isSpanStart(type: string): boolean {
    return type.endsWith(":start")
}

/** True for any closing half of a span bracket (complete, failed, or interrupted). */
export function isSpanEnd(type: string): boolean {
    return SPAN_END_SUFFIXES.some(suffix => type.endsWith(suffix))
}

/**
 * The stem shared by one span's members — `"kernel:run:start"` → `"kernel:run"`.
 * Returns the type unchanged when it is not a span member, so a caller can
 * use it as a grouping key over a mixed stream without pre-filtering.
 */
export function spanStem(type: string): string {
    for (const suffix of SPAN_SUFFIXES) {
        if (type.endsWith(suffix)) return type.slice(0, -suffix.length)
    }
    return type
}
