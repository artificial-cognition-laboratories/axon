import type { AxonEngineResponse } from "../../engine"

/**
 * The engine wire contract — what every AxonEngine.stream() yields, and what
 * kernel.stream() hands the cognet raw. Honestly named: this is engine:*,
 * not agent:* cosplaying as the cognet's own committed vocabulary — the
 * cognet reads these and DECIDES whether/how to act (output() a block,
 * run() a code block); it never receives something pre-labeled as its own
 * output. kernel:engine:* (the tick/phase telemetry, unrelated file) is the
 * durable accounting span around a call; this is the call's actual content.
 *
 * Reasoning/"thinking" tokens are dropped at the adapter boundary (engine.ts
 * in core) and never reach this wire at all — thinking was never a data
 * kind, it was one specific inference pipeline's internal stage. If a
 * distributed multi-model cognet has something analogous, that's an
 * inference-side concern with no single causal stream to represent here.
 *
 * Deltas are wire-only — forwarded live to clients, never persisted.
 * Blocks are complete — the cognet decides what becomes a durable fact.
 */

/** Streaming chunks — transient, never enter a log. */
export type AxonEngineDelta =
    { type: "engine:text:delta"; content: string }

/** Complete parsed blocks. */
export type AxonEngineBlock =
    | { type: "engine:text"; content: string }
    /** id is minted at parse time by the AIR parser. The kernel's run() mints its own action id independently, so this parse-time id is currently unconsumed downstream. */
    | { type: "engine:typescript"; id: string; content: string }
    /** A format violation in the model's output. */
    | { type: "engine:output:error"; code: string; message: string; excerpt?: string }

export type AxonEngineEvent =
    | AxonEngineDelta
    | AxonEngineBlock
    /**
     * The model emitted <done/> this tick — its own explicit stop signal.
     * Causal, not inferred: a loop def reads this directly rather than
     * guessing from what blocks did or didn't appear (a text-only tick is
     * NOT implicitly terminal — a model can speak across several ticks and
     * only stop when it actually says so).
     */
    | { type: "engine:stop" }
    /** Terminal — carries the authoritative full response and billing meta. Always emitted once per call, independent of <done/>. */
    | { type: "engine:done"; response: AxonEngineResponse }
