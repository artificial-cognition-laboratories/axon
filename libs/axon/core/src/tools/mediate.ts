import type { PolicyRule } from "@arcforge/types"

/**
 * The mediation wrapper — every tool call passes through here before it runs.
 *
 * Lifted from the capsule's `process/scope.ts`, unchanged in substance: it
 * recursively proxies callables so no caller can ever reach an unwrapped
 * function, checks policy, and brackets the call with fn:start/complete/failed
 * spans. That logic was never about the process boundary; it works identically
 * whether the tool lives across a wire or in this heap, which is why it moves
 * intact rather than being rewritten.
 *
 * ── What changes, and what deliberately does not ────────────────────────────
 *
 * What changes is the mediator's ROLE. In the capsule it was the security
 * boundary. Once the whole agent runs inside an OS box, bwrap is the wall — a
 * path outside the policy does not exist, a denied network has no socket — and
 * this becomes the AUDIT and ESCALATION layer: typed denials the agent can
 * reason about, human-in-the-loop prompts the OS cannot express, and the span
 * stream Fleet folds into its flame graph.
 *
 * What does not change is that it still runs. A demoted mediator is not a
 * removed one: the OS wall cannot say "ask the user about this one command",
 * and a denial that arrives as ENOENT teaches the model nothing.
 */

export type MediateOpts = {
    /**
     * Policy check for one call. Resolves allow/deny; an escalation is awaited
     * inside it, so this promise settling means the verdict is final.
     */
    check(fn: string, subject: string, args: unknown[], owner: string): Promise<boolean>
    /** Span emission — the audit trail every surface reads. */
    emit: {
        start(input: { module: string; fn: string; args: unknown[] }): void
        complete(input: { module: string; fn: string; result: unknown; durationMs: number }): void
        failed(input: { module: string; fn: string; error: unknown; durationMs: number }): void
    }
}

/**
 * Wrap one exported value so every call beneath it is mediated.
 *
 * Recursive by necessity: a tool may export an object of functions, or an
 * object of objects. Wrapping only the top level would leave `github.pr.open`
 * unmediated while `github.open` was checked — the kind of gap that is
 * invisible until someone finds it.
 *
 * `receiver` carries the original `this` through Reflect.apply, so a tool
 * written as a class method or an object literal using `this` keeps working.
 */
export function mediate(opts: MediateOpts, value: unknown, path: string, owner: string, receiver?: object): unknown {
    if (typeof value === "function") {
        return async (...args: unknown[]) => {
            // The first string argument is what a glob rule matches against —
            // a path, a host, a command. A tool taking no string simply has
            // nothing to match, and the rule's bare verdict decides.
            const subject = typeof args[0] === "string" ? args[0] : ""
            const allowed = await opts.check(path, subject, args, owner)
            if (!allowed) throw new Error(`CAPSULE_POLICY_DENIED: ${path} denied by policy`)

            // The span opens only AFTER policy admits the call: a denied call
            // is a policy fact, not an execution that failed, and pairing a
            // :start with no matching end would leave a permanently-open
            // bracket in every flame graph.
            const started = Date.now()
            opts.emit.start({ module: owner, fn: path, args })
            try {
                const result = await Reflect.apply(value as (...a: unknown[]) => unknown, receiver, args)
                opts.emit.complete({ module: owner, fn: path, result, durationMs: Date.now() - started })
                return result
            } catch (cause) {
                opts.emit.failed({ module: owner, fn: path, error: cause, durationMs: Date.now() - started })
                throw cause
            }
        }
    }

    if (value !== null && typeof value === "object") {
        return new Proxy(value, {
            get(target, key) {
                const child = Reflect.get(target, key, target)
                return typeof key === "string" ? mediate(opts, child, `${path}.${key}`, owner, target) : child
            },
        })
    }

    return value
}

/** Re-exported so a caller can name the rule shape without reaching for types. */
export type { PolicyRule }
