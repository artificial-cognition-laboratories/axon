import { err } from "@arcforge/err"
import type { ResourceBudget } from "@arcforge/types"
import { formatSize, parseSize, probeHardware, type Hardware } from "./hardware"
import { Reservations, type Reservation, type ReservationsT } from "./reservations"

/**
 * Resources — what local inference may use on this machine, and what it is
 * using now.
 *
 * A PLATFORM service, not a kernel one. Hardware is environment, and ring 0
 * must not grow a machine model: a cognet asks for a role and receives a
 * working handle, exactly as it never learns which provider filled it. This
 * is what the provider consults before loading weights, and what Fleet reads
 * to show a person their own machine.
 *
 * ── Refuse, never evict ──────────────────────────────────────────────────
 *
 * A load that does not fit is refused with a message naming what is holding
 * the memory. It does NOT evict another agent's model, deliberately: eviction
 * needs a policy — least-recently-used? lowest-priority? — and nobody has
 * tuned one. A refusal is a bad experience a user can act on; a silent
 * eviction is another agent mysteriously slowing down.
 *
 * That does mean a second agent can fail where a first succeeded, which is a
 * real cost. It is the honest one until there is a policy worth defending.
 */

export type ResourceState = {
    hardware: Hardware
    /** The declared ceiling in bytes, or null when none was declared or it was unreadable. */
    budget: number | null
    /** Bytes held by live holders across every binary on this machine. */
    held: number
    /**
     * Bytes a new load may take, or null when nothing bounds it.
     *
     * Null is UNBOUNDED, not zero — an unmeasurable GPU with no declared
     * budget genuinely has no known limit, and refusing every load there
     * would make local inference unavailable on most machines.
     */
    available: number | null
    /** What is loaded right now, for a surface that lists it. */
    reservations: Reservation[]
}

type ResourcesOpts = {
    /**
     * The active profile's declared ceiling, read fresh per call.
     *
     * A FUNCTION for the same reason providers are: the active profile changes
     * while the process runs, and a captured value keeps serving the one that
     * was active at boot.
     */
    budget?: () => ResourceBudget | undefined
    /** Injectable so tests never touch a developer's real reservation directory. */
    reservations?: ReservationsT
}

export function Resources(opts: ResourcesOpts = {}) {
    const hardware = probeHardware()
    const reservations = opts.reservations ?? Reservations()

    /**
     * The effective ceiling.
     *
     * The declared budget wins where it exists, even above the measured
     * hardware — a user who says 4GB on a 24GB card means it. Where nothing
     * is declared, the hardware is the ceiling. Where neither is known, there
     * is no ceiling, and that is reported honestly rather than guessed at.
     */
    function ceiling(): number | null {
        const declared = parseSize(opts.budget?.()?.vram)
        if (declared !== null) return declared
        return hardware.vram ?? null
    }

    function state(): ResourceState {
        const live = reservations.live()
        const held = live.reduce((total, entry) => total + entry.bytes, 0)
        const limit = ceiling()

        return {
            hardware,
            budget: parseSize(opts.budget?.()?.vram),
            held,
            // Never negative: over-commitment is possible (a load that grew
            // past its estimate) and reporting it as a negative allowance
            // would make every caller handle a sign.
            available: limit === null ? null : Math.max(0, limit - held),
            reservations: live,
        }
    }

    return {
        get hardware(): Hardware {
            return hardware
        },

        state,

        /**
         * Would a load of this size fit?
         *
         * True when nothing bounds it — see ResourceState.available. Callers
         * that want the reason use `admit`, which throws with one.
         */
        fits(bytes: number): boolean {
            const { available } = state()
            return available === null || bytes <= available
        },

        /**
         * Take a hold, or refuse with a message naming what is in the way.
         *
         * Returns a RELEASE FUNCTION rather than a handle: the only thing a
         * caller may do with a reservation is give it back, and a function is
         * the smallest shape that says so. Idempotent — releasing twice is
         * not an error, because a shutdown path racing an unload is ordinary.
         */
        admit(entry: { agent: string; role: string; model: string; bytes: number }): () => void {
            const current = state()

            if (current.available !== null && entry.bytes > current.available) {
                const holders = current.reservations
                    .map(held => `  ${held.agent} · ${held.role} · ${held.model} — ${formatSize(held.bytes)}`)
                    .join("\n")

                throw err("RESOURCES_EXHAUSTED", {
                    detail: `${entry.model} needs ${formatSize(entry.bytes)}, `
                        + `${formatSize(current.available)} available of ${formatSize(current.budget ?? hardware.vram ?? 0)}.`
                        + (holders ? `\n\nheld by:\n${holders}` : ""),
                    context: {
                        model: entry.model,
                        needs: entry.bytes,
                        available: current.available,
                    },
                })
            }

            const path = reservations.take(entry)
            let released = false
            return () => {
                if (released) return
                released = true
                reservations.release(path)
            }
        },

        /** Release everything this process holds. The shutdown path. */
        releaseAll(): void {
            reservations.releaseAll()
        },
    }
}

export type ResourcesT = ReturnType<typeof Resources>
