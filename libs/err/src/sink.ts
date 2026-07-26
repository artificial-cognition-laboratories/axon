import { AsyncLocalStorage } from "node:async_hooks"
import type { AxonError } from "./err"

/**
 * Error attribution is a SCOPE, not a global. A process may host several
 * Axon() runtimes at once, each with its own session log — a module-global
 * sink (the old design) meant every error landed in whichever session
 * registered last, silently misattributing instance A's failures to
 * instance B's durable record.
 *
 * Instead, each runtime establishes its sink over its own well-defined
 * entry points (Axon() construction, each kernel wake, reload) via
 * AsyncLocalStorage: errScope.run(sink, fn). Every err() constructed
 * anywhere downstream of that call — through awaits, promise chains,
 * nested calls — reaches THAT runtime's session and no other.
 *
 * An err() constructed outside any scope (CLI tooling, tests, a callback
 * scheduled outside a runtime's flow) reaches no sink: the error still
 * throws and propagates to its catcher, which owns visibility at host
 * level. Losing telemetry there is visible and fixable; misattribution
 * would be a lie in the durable record — this fails in the right direction.
 */
export type AxonErrorSink = (error: AxonError) => void

const storage = new AsyncLocalStorage<AxonErrorSink>()

export const errScope = {
    /** Run fn with every err() constructed downstream delivered to sink. Scopes nest — the innermost wins. */
    run<T>(sink: AxonErrorSink, fn: () => T): T {
        return storage.run(sink, fn)
    },
}

/** err()'s delivery call — the current scope's sink, or nothing (see module doc). */
export function emitError(error: AxonError): void {
    storage.getStore()?.(error)
}
