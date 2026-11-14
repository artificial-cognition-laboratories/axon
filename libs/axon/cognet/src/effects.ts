import { AsyncLocalStorage } from "node:async_hooks"
import { err } from "@arcforge/err"

/** One thing a run asked the kernel to do that needs no answer — an output, an emit, a fault — made when it lands. */
export type Effect = () => void | Promise<void>

/**
 * Effects — when a run's effects reach the kernel.
 *
 * The rule, the same in every language: an effect leaves the next time the
 * run hands control back to the host. A sync run hands back only when it
 * finishes, so its effects are HELD and made once its writes are in the
 * world, in the order it made them. An async run hands back at every await,
 * so outside a hold an effect is made at once.
 *
 * Held effects are made inside the run's own bracket by whoever lands it, so
 * one that fails fails the tick — never a promise nobody awaited.
 */
export function Effects() {
    const holding = new AsyncLocalStorage<{ effects: Effect[]; open: boolean }>()

    return {
        /** Run `fn`, holding every effect it makes. */
        hold<T>(fn: () => T): { result: T; effects: Effect[] } {
            const held = { effects: [] as Effect[], open: true }
            try {
                return { result: holding.run(held, fn), effects: held.effects }
            } finally {
                // A promise the run left behind still carries this hold; what it sends now would never be made.
                held.open = false
            }
        },

        /** Whether a sync run is holding effects right now. */
        holding(): boolean {
            return holding.getStore()?.open === true
        },

        /** An effect, made now — or held, when a sync run is holding. A held one resolves at once. */
        send(effect: Effect): Promise<void> {
            const held = holding.getStore()
            if (held && !held.open) throw err("COGNET_EFFECT_LATE", { detail: "a sync run's promise reached the kernel after the run had finished — await it inside an `async run()`" })
            if (held) {
                held.effects.push(effect)
                return Promise.resolve()
            }
            return Promise.resolve(effect())
        },

        /** Make held effects, in order, each finished before the next. */
        async make(effects: readonly Effect[]): Promise<void> {
            for (const effect of effects) await effect()
        },
    }
}

/** The one process-wide instance: the host's kernel sends through it and the schedule lands what it held. */
export const effects = Effects()
