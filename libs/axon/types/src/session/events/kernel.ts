import type { AxonEngineFault, AxonEngineMessage, AxonEngineMeta } from "../../engine"
import type { AxonLogEvents } from "./log"
import type { AxonCancellableSpan, AxonSpan } from "./span"

/**
 * Kernel telemetry — the machinery's own record, emitted by the kernel and
 * ONLY the kernel. Programs cannot produce these (abi.emit is typed against
 * program:* alone); their world clock lives in AxonProgramEventMap.
 *
 * Session-level: these describe how the machinery ran, never what the model
 * or client sees. runId rides in the event context.
 */
export type AxonKernelEventMap =
    & AxonLogEvents<"kernel">
    // ── Run — one wake, exec to quiescence. The process accounting record. ──
    //
    // :failed deliberately carries NO error payload — the first documented
    // exception to the span standard. err()'s sink already emitted the
    // canonical "axon:error" event at the throw site (see @axon/err/sink.ts),
    // so duplicating the AxonError here would put the same failure in the
    // log twice under two names. This is pure run-accounting: the wake
    // ended, and it ended badly — the error's own record says how.
    & AxonCancellableSpan<
        "kernel:run",
        {},
        {},
        {},
        { reason: "user" | "shutdown" }
    >
    // ── Engine calls — the billing and latency record ────────────────────────
    // Emitted by the Engine() manager around every call — a program cannot
    // skip them: every token passes this meter by construction.
    //
    // :failed carries AxonEngineFault, not AxonError — the second and last
    // documented exception. A provider fault is a distinct, richer domain
    // shape (code, provider, model, retryable, retryAfterMs) that drives
    // retry policy; flattening it into a generic AxonError would lose the
    // fields the retry loop and the billing view both read.
    & AxonSpan<
        "kernel:engine",
        { provider: string; model?: string },
        /**
         * The other half of the call kernel:engine:input opened, same spanId —
         * together they tell the whole story: input (what the model saw),
         * output (exactly what it produced, raw, pre-AIR-parse), meta (billing/
         * observability). text/thinking are the same fields AxonEngineResponse
         * already carries in-process; this is that response actually made
         * durable instead of being dropped after the AIR parser consumes it.
         */
        { attempts: number; text: string; thinking?: string; stopReason: "end" | "length" | "abort"; meta: AxonEngineMeta },
        { attempts: number; fault: AxonEngineFault }
    >
    /**
     * A non-generate engine call — ASR, embeddings, depth, TTS.
     *
     * Its OWN family rather than a reuse of kernel:engine, because that span's
     * completion carries text, a stop reason and token meta: a depth map has
     * none of those, and a transform forced into that shape would have to lie
     * about four fields. Same reason kernel:run is not kernel:engine.
     *
     * The payload never appears — it is a tensor, an image or a waveform, and
     * the log records what happened rather than copying what moved. What is
     * here is the thing a reader wants: which role, which model, how long.
     *
     * `stream` engines are bracketed at OPEN and CLOSE, not per push. A VAD at
     * 30Hz is 1800 pushes a minute; a span for each would drown every other
     * event in the log, and the session's lifetime is the interval that
     * actually means something.
     */
    & AxonSpan<
        "kernel:transform",
        { role: string; provider: string; model?: string },
        { role: string; durationMs: number },
        { role: string; fault: AxonEngineFault }
    >
    & {
        /**
         * The rendered AIR document handed to the engine for this call — what the
         * model actually saw. Same spanId as the paired kernel:engine:start, so
         * a trace can pull a call's input by shared span without extra plumbing.
         * Devtools-only: never rendered to the user, never part of entry state.
         */
        "kernel:engine:input": { messages: AxonEngineMessage[]; bytes: number }
        "kernel:engine:retry": { attempt: number; nextAttempt: number; delayMs: number; fault: AxonEngineFault }
        /**
         * The first provider delta crossed the boundary — the moment an engine
         * call stops waiting and starts producing.
         *
         * Not a span, and deliberately so: this is an INSTANT inside the
         * kernel:engine bracket, not a bracket of its own. The two intervals a
         * reader wants (latency before it, generation after it) are both
         * derivable from one marker plus the ends that already exist, so a
         * second pair of start/complete events would be two lines describing
         * the same split.
         *
         * `meta.firstTokenMs` on :complete carries the same number, but only in
         * arrears and only for a call that finished. This is emitted AS IT
         * HAPPENS, which is what makes it drawable on a live bar and what keeps
         * the split visible on a call that was interrupted or failed mid-stream
         * — precisely the calls where "was it slow to start or slow to finish"
         * is the question being asked.
         *
         * Same spanId as its kernel:engine:start, per attempt: a retried call
         * emits one per attempt, and `attempt` distinguishes them.
         */
        "kernel:engine:firstToken": { attempt: number; elapsedMs: number }
    }
