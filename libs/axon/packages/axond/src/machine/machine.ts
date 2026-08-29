import { Hardware } from "./hardware"
import { Identity } from "./identity"
import { Probe } from "./probe"
import { Residency } from "./residency"
import { Samples } from "./samples"
import type { Admission, MachineState } from "./types"

export type MachineOpts = {
    /**
     * The declared video-memory ceiling in bytes, read fresh per call.
     *
     * A THUNK because the active profile changes while the daemon runs, and a
     * captured value keeps serving the one that was active at boot. Null means
     * none declared, and the measured hardware is the ceiling.
     */
    budget?: () => number | null
    /** Where holds are written. Tests point this at a scratch dir. */
    residencyRoot?: string
}

/**
 * Machine — this box, as the daemon's one authority on it.
 *
 * Three questions, three leaves, kept apart deliberately: `hardware` answers
 * what the box HAS, `probe`/`samples` answer what is IN USE, and `residency`
 * answers what WE hold. A manager that reads only the third accepts a load
 * that then OOMs, because the browser holding three gigabytes of video memory
 * is real and Axon did not put it there.
 *
 * ── Refuse, never evict ─────────────────────────────────────────────────────
 *
 * A load that does not fit is refused, with the holders named. It does NOT
 * evict another agent's model: eviction needs a policy — least recently used?
 * lowest priority? — and nobody has tuned one. A refusal is a bad experience a
 * user can act on; a silent eviction is another agent mysteriously slowing
 * down.
 *
 * That does mean a second agent can fail where a first succeeded. It is the
 * honest cost until there is a policy worth defending, and the moment there is
 * one, `admit` is where it goes.
 */
export function Machine(opts: MachineOpts = {}) {
    const identity = Identity()
    const hardware = Hardware()
    const probe = Probe()
    const residency = Residency(opts.residencyRoot !== undefined ? { root: opts.residencyRoot } : {})

    const samples = Samples({
        probe: probe,
        // Polling faster only earns its cost while something is loaded — see
        // the rates in Samples.
        busy: () => residency.live().length > 0,
    })

    /**
     * The effective ceiling, or null when nothing bounds a load.
     *
     * The declared budget wins even above the measured hardware: a user who
     * says 4GB on a 24GB card means it. Where nothing is declared the hardware
     * is the ceiling, and where neither is known there is genuinely no limit —
     * reported honestly rather than guessed at, because guessing zero refuses
     * every local model on any machine we cannot measure.
     */
    function ceiling(): number | null {
        return opts.budget?.() ?? hardware.current().vram
    }

    return {
        identity: identity,
        hardware: hardware,
        samples: samples,
        residency: residency,

        /** Everything the machine reports, in one read. */
        state(): MachineState {
            const holds = residency.live()
            return {
                identity: identity.current(),
                capacity: hardware.current(),
                usage: samples.latest() ?? probe.read(),
                budget: opts.budget?.() ?? null,
                held: holds.reduce((total, hold) => total + hold.bytes, 0),
                holds: holds,
                samples: samples.history(),
            }
        },

        /**
         * Would `bytes` fit right now?
         *
         * Measured against the WHOLE machine's usage where it can be read, not
         * just Axon's holds — the honest question is what the driver will give
         * us, and something else may already have taken it.
         *
         * Reads fresh rather than trusting the last sample: a two-second-old
         * figure is two seconds in which another process could have taken the
         * memory, and an admission check is exactly where that matters.
         */
        admit(bytes: number): Admission {
            const limit = ceiling()
            if (limit === null) return { ok: true, headroom: null }

            const usage = samples.now()
            const holds = residency.live()
            const held = holds.reduce((total, hold) => total + hold.bytes, 0)

            // Prefer the driver's own figure — it counts every process on the
            // machine. Our own accounting is the fallback where the GPU cannot
            // be probed, and it can only under-report, never over.
            const used = usage.vramUsed ?? held
            const available = Math.max(0, limit - used)

            return available >= bytes
                ? { ok: true, headroom: available - bytes }
                : { ok: false, wanted: bytes, available: available, holders: holds }
        },

        /** Begin polling. Called once when the daemon starts serving. */
        start(): void {
            samples.start()
        },

        /**
         * Stop polling and release this process's holds.
         *
         * Releasing matters: a daemon that exits holding records leaves the
         * machine looking fuller than it is until something else reaps them.
         */
        stop(): void {
            samples.stop()
            residency.releaseAll()
        },
    }
}

export type MachineT = ReturnType<typeof Machine>
