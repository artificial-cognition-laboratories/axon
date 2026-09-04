import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { err } from "@arcforge/err"

type BudgetOpts = {
    /** Where the declaration lives. Tests point this at a scratch file. */
    path?: string
}

/**
 * Budget — the declared video-memory ceiling, and the only thing that can
 * outrank measured hardware.
 *
 * ── Why a file ──────────────────────────────────────────────────────────────
 *
 * A ceiling a person sets is a preference, not a runtime fact: it has to
 * survive the daemon restarting and has to be visible to a CLI invoked while
 * no daemon is listening. A file under the user's own store is both, and it is
 * the same degraded path every other reader here already takes.
 *
 * ── Read fresh, never cached ────────────────────────────────────────────────
 *
 * `Machine` reads through a thunk precisely so a change takes effect on the
 * next admission rather than the next boot. Caching the value here would put
 * that back: a user who lowers their ceiling because a game is starting means
 * it now, and being told to restart a daemon they did not know existed is the
 * opposite of what this product claims.
 *
 * ── Null is "no declaration", never zero ────────────────────────────────────
 *
 * An absent file means the measured hardware is the ceiling. Zero is a
 * declaration that nothing may load, which is a thing a person may legitimately
 * want and must not be confused with having said nothing at all.
 */
export function Budget(opts: BudgetOpts = {}) {
    const path = opts.path ?? join(homedir(), ".axon", "budget.json")

    return {
        /** Where the declaration is written. Diagnostics. */
        get path(): string {
            return path
        },

        /** The declared ceiling in bytes, or null when none is declared. */
        current(): number | null {
            if (!existsSync(path)) return null

            try {
                const parsed = JSON.parse(readFileSync(path, "utf-8")) as { bytes?: unknown }
                const bytes = parsed?.bytes
                if (bytes === null || bytes === undefined) return null
                return typeof bytes === "number" && Number.isFinite(bytes) && bytes >= 0 ? bytes : null
            } catch {
                // A corrupt declaration is not a ceiling. Falling back to the
                // measured hardware is the safe direction: it can only allow
                // what the card actually has, where a garbled number could
                // allow more.
                return null
            }
        },

        /**
         * Declare a ceiling, or clear it with null.
         *
         * Refuses a negative or non-finite value rather than storing it: this
         * is written by a user-facing control, and the failure a caller wants
         * is at the setting, not at the next admission check.
         */
        set(bytes: number | null): void {
            if (bytes !== null && (!Number.isFinite(bytes) || bytes < 0)) {
                throw err("MACHINE_BUDGET_INVALID", {
                    detail: `a budget must be a non-negative number of bytes, or null to clear it — got ${bytes}`,
                    context: { bytes: String(bytes) },
                })
            }

            if (bytes === null) {
                rmSync(path, { force: true })
                return
            }

            mkdirSync(dirname(path), { recursive: true })
            writeFileSync(path, JSON.stringify({ bytes: Math.floor(bytes) }, null, 4), "utf-8")
        },
    }
}

export type BudgetT = ReturnType<typeof Budget>
