import type { CapsuleScope, CapsuleScopeUnavailable } from "@arcforge/types"

/**
 * Bindings — what a submission left on the sandbox's globalThis.
 *
 * Bun's REPL transform hoists every top-level declaration (const, let, var,
 * function) onto the real global object. That is not a side effect to work
 * around — it is the mechanism that makes "declarations persist into later
 * blocks" true, and this reads exactly that state. There is no second
 * capture path, no instrumentation of user code, and no VM facade.
 *
 * Scope is diffed per submission rather than accumulated: a template
 * interpolates the values ITS OWN script produced, not whatever survives
 * from three blocks ago. `snapshot()` before the eval, `since()` after.
 *
 * Values cross a process boundary as JSON, so anything that cannot be
 * represented is reported BY NAME with a reason rather than dropped. A
 * dropped function would render as `undefined` in a template with nothing
 * to explain it; a named one lets the failure say what actually happened.
 */

/**
 * Every own property of globalThis right now, name AND current value.
 *
 * Values, not just names: a submission that REDECLARES a name from an
 * earlier block (`const v = 1` then `const v = 99`) leaves a binding that
 * already existed, so a name-only diff would miss it entirely and the
 * template would interpolate nothing. Identity comparison catches the
 * rebind; a block that merely reads an old binding without touching it
 * leaves the same reference and is correctly excluded.
 */
export function snapshot(): Map<string, unknown> {
    const seen = new Map<string, unknown>()
    for (const name of Object.getOwnPropertyNames(globalThis)) {
        try {
            seen.set(name, (globalThis as Record<string, unknown>)[name])
        } catch {
            // A throwing getter has no stable prior value; treating it as
            // present-but-unknown keeps it out of the diff either way.
            seen.set(name, undefined)
        }
    }
    return seen
}

/**
 * The bindings this submission declared or rebound, classified into what can
 * cross and what cannot.
 *
 * `exclude` is the tool namespaces — Runner attaches those to globalThis on
 * every run, so without this they would read as freshly declared bindings on
 * the first submission and put the entire tool surface into the scope.
 */
export function since(before: Map<string, unknown>, exclude: Iterable<string> = []): CapsuleScope {
    const skip = new Set(exclude)
    const values: Record<string, unknown> = {}
    const unavailable: CapsuleScopeUnavailable[] = []
    const budget: Budget = { spent: 0 }

    for (const name of Object.getOwnPropertyNames(globalThis)) {
        if (skip.has(name)) continue

        // A getter that throws is a property of the binding, not a reason to
        // lose the whole scope.
        let value: unknown
        try {
            value = (globalThis as Record<string, unknown>)[name]
        } catch {
            if (!before.has(name)) unavailable.push({ name, reason: "unserializable" })
            continue
        }

        // Unchanged bindings belong to earlier blocks, not this one.
        if (before.has(name) && Object.is(before.get(name), value)) continue

        const verdict = classify(value, budget)
        if (verdict) unavailable.push({ name, reason: verdict })
        else values[name] = value
    }

    return { values, unavailable }
}

/**
 * The total serialized size a scope may occupy, in characters.
 *
 * A script is free to build whatever it likes in the sandbox, but the scope
 * crosses a process boundary on every run — so a loop that reads a repository
 * into a local array would otherwise put all of it on the wire whether or not
 * the template names it. Oversized bindings are reported by name like any
 * other value that cannot cross, so a template referencing one gets a
 * specific error rather than silence.
 *
 * Generous on purpose: interpolating a large file IS the feature (that is the
 * transcription this format exists to avoid), so the budget has to clear a
 * realistic document by a wide margin and only catch the runaway case.
 */
const SCOPE_BUDGET_CHARS = 2_000_000

type Budget = { spent: number }

/**
 * Why a value cannot cross, or null when it can.
 *
 * Serializability is decided by actually serializing — the only honest test,
 * since a cycle or a throwing toJSON is not visible from the value's type.
 * The encoded length is charged against the run's budget here, so a scope is
 * measured exactly once rather than probed and then re-encoded blindly.
 */
function classify(value: unknown, budget: Budget): CapsuleScopeUnavailable["reason"] | null {
    if (typeof value === "function") return "function"

    let encoded: string | undefined
    try {
        // undefined rather than a throw is JSON.stringify's OTHER failure
        // mode — bigint throws, but symbol/undefined return undefined, and
        // treating that as success would put a value on the wire that
        // serializing the enclosing event then fails on, taking the whole
        // run's result down with it.
        encoded = JSON.stringify(value)
    } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        return /cyclic|circular/i.test(message) ? "circular" : "unserializable"
    }

    if (encoded === undefined) return "unserializable"

    if (budget.spent + encoded.length > SCOPE_BUDGET_CHARS) return "oversized"
    budget.spent += encoded.length
    return null
}
