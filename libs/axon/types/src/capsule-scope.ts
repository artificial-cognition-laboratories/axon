/**
 * The bindings a capsule run left behind — what a rendered template may
 * interpolate.
 *
 * Bun's REPL transform hoists every top-level declaration onto the sandbox's
 * real globalThis, which is what makes "declarations persist into later
 * blocks" true. Scope extraction reads that same state: it is a diff of
 * globalThis across one submission, never a second capture mechanism.
 *
 * Values cross a process boundary, so only JSON-representable ones can come
 * with. Everything else is reported by NAME with a reason instead of being
 * silently dropped — a template interpolating a function would otherwise
 * render `undefined` with nothing to explain it, and the model would have no
 * way to know what it did wrong.
 */
export type CapsuleScope = {
    /** Bindings whose values crossed intact. */
    values: Record<string, unknown>
    /** Bindings that exist in the sandbox but could not cross, by name. */
    unavailable: CapsuleScopeUnavailable[]
}

export type CapsuleScopeUnavailable = {
    name: string
    /**
     * function  — a callable; meaningless outside the sandbox that owns it.
     * circular  — self-referencing structure; not representable as JSON.
     * unserializable — threw during serialization (getters, BigInt, ...).
     * oversized — the run's scope budget was exhausted before this binding.
     *   A script may build anything in the sandbox, but the scope crosses a
     *   process boundary every run; a runaway accumulation is reported by
     *   name rather than put on the wire.
     */
    reason: "function" | "circular" | "unserializable" | "oversized"
}

/** An empty scope — the honest value for a run that declared nothing. */
export const EMPTY_CAPSULE_SCOPE: CapsuleScope = { values: {}, unavailable: [] }
