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

/**
 * Observers that see EVERY error, regardless of scope.
 *
 * Separate from the scoped sink above because they answer a different
 * question. The scoped sink asks "whose durable record does this belong
 * to" — attribution, where being wrong is a lie on disk, which is why it is
 * exclusive and innermost-wins. An observer asks "did this happen at all",
 * where the failure mode of getting it wrong is a missing report, not a
 * false one.
 *
 * Making crash reporting a second scope would have meant either competing
 * with the session for the same slot (whichever ran last wins, errors
 * vanish) or two AsyncLocalStorage contexts to keep in sync at every entry
 * point. A flat observer list has neither problem: it fires for errors
 * constructed inside a session scope AND for the ones outside it, which are
 * exactly the CLI and tooling failures a session log could never see.
 *
 * Deliberately NOT given the ability to suppress or alter the error. An
 * observer is told, not consulted.
 */
const observers = new Set<AxonErrorSink>()

/**
 * Watch every error constructed anywhere in this process.
 *
 * Returns an unsubscribe function. Intended for ONE caller per process —
 * the host's crash reporter — established at startup. A leaf reaching for
 * this is a design error: leaves throw, hosts observe.
 */
export function observeErrors(observer: AxonErrorSink): () => void {
    observers.add(observer)
    return () => observers.delete(observer)
}

/**
 * err()'s delivery call — the current scope's sink, then every observer.
 *
 * An observer that throws must never break error CONSTRUCTION: err() is on
 * the failure path by definition, and a reporter that turns one failure
 * into two (the original plus its own) is worse than no reporter. Each is
 * isolated so one bad observer cannot starve the rest.
 *
 * The scoped sink is called first and is deliberately NOT wrapped — it is
 * the runtime's own durable record, and a failure to write it is a real
 * problem the runtime should see, not something this function should hide.
 */
export function emitError(error: AxonError): void {
    storage.getStore()?.(error)

    for (const observer of observers) {
        try {
            observer(error)
        } catch {
            // See above — an observer's fault never propagates into err().
        }
    }
}
