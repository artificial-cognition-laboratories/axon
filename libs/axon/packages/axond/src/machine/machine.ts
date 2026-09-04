import { Hardware } from "./hardware"
import { Budget } from "./budget"
import { Identity } from "./identity"
import { Probe } from "./probe"
import { Share } from "./share"
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
    /**
     * Process groups Axon owns beyond this one, read fresh per call.
     *
     * A THUNK because agents come and go while the daemon runs. Only the
     * `/proc` fallback in `Share` consults it — under systemd the cgroup is
     * the membership list — so a caller that omits it still gets an attributed
     * share on any machine running the unit.
     */
    groups?: () => number[]
    /** Where holds are written. Tests point this at a scratch dir. */
    residencyRoot?: string
    /** Where the declared ceiling is written. Tests point this at a scratch file. */
    budgetPath?: string
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
/** How many readings `state()` carries. Enough for any chart, small enough to send often. */
const WIRE_SAMPLES = 180

export function Machine(opts: MachineOpts = {}) {
    /**
     * How many callers are currently reading the sample ring.
     *
     * `Samples` drops to a ten-second cadence when nothing is resident,
     * reasoning that with no admission pending there is "nobody watching a
     * graph". A desktop panel streaming state is exactly that somebody, and it
     * arrived after the assumption did — so interest is now something a caller
     * declares rather than something inferred from residency alone.
     *
     * A count rather than a flag: two surfaces open at once must not have the
     * first one closing drop the cadence under the second.
     */
    let observers = 0

    /**
     * When the last REMOTE watcher's interest expires, epoch ms.
     *
     * A lease rather than a second counter, because the counter above is only
     * safe in-process: `observe` hands back a closure, so the release is
     * guaranteed by the caller's own scope. A client on the far side of a
     * socket has no such guarantee — a panel that crashes or a pipe that
     * breaks would leave the count raised, and the daemon would poll at the
     * fast cadence forever with nobody looking. An expiring lease costs the
     * watcher one call per tick and cannot leak.
     */
    let leasedUntil = 0

    const identity = Identity()
    const hardware = Hardware()
    const probe = Probe()
    const residency = Residency(opts.residencyRoot !== undefined ? { root: opts.residencyRoot } : {})
    const budget = Budget(opts.budgetPath !== undefined ? { path: opts.budgetPath } : {})

    /**
     * The declared ceiling, read fresh on every ask.
     *
     * `opts.budget` still wins where a caller supplies one — that is how a
     * test pins a ceiling without a file — and the stored declaration is the
     * answer for everyone else. Before this there was no source at all: the
     * thunk was optional, nothing passed it, and `budget` was permanently null
     * however the product described the feature.
     */
    /** Whether anything — in this process or across the socket — is drawing these readings. */
    const watchedNow = (): boolean => observers > 0 || Date.now() < leasedUntil

    const declared = (): number | null => opts.budget?.() ?? budget.current()

    /**
     * What Axon costs this machine.
     *
     * Its process groups come from the agent records: an agent is a launcher
     * plus the runtime it spawned, so the GROUP is the unit of ownership — the
     * same one `agents.signal` already uses. Only the `/proc` fallback needs
     * them; under systemd the cgroup answers on its own.
     */
    const share = Share({
        groups: () => opts.groups?.() ?? [],
        // The per-process video-memory query is a second nvidia-smi, ~25ms on
        // top of the machine probe's own. Worth it while a graph is on screen
        // and not worth it otherwise, so it follows the same gate the fast
        // cadence does.
        gpu: () => watchedNow(),
    })

    const samples = Samples({
        probe: probe,
        share: share,
        held: () => residency.held(),
        // Polling faster only earns its cost while something is loaded — see
        // the rates in Samples.
        busy: () => residency.live().length > 0 || watchedNow(),
        // Someone is drawing the readings, so they arrive four times as often.
        watched: () => watchedNow(),
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
        return declared() ?? hardware.current().vram
    }

    return {
        identity: identity,
        hardware: hardware,
        samples: samples,
        residency: residency,

        /**
         * The declared ceiling: read it, set it, clear it with null.
         *
         * A nested bag rather than `setBudget`, so the verb path a socket
         * walks reads `machine.budget.set` — the noun owns its verbs, and a
         * surface offering the control gets the getter beside it.
         */
        budget: {
            current: () => declared(),
            set: (bytes: number | null) => budget.set(bytes),
            get path() { return budget.path },
        },

        /** Everything the machine reports, in one read. */
        state(): MachineState {
            const holds = residency.live()
            return {
                identity: identity.current(),
                capacity: hardware.current(),
                // `now()` rather than the bare probe: a reading has to carry
                // our share alongside the machine's, and Samples is what knows
                // how to stamp it. Before the first poll it takes one.
                usage: samples.latest() ?? samples.now(),
                budget: declared(),
                // The domain's own figure, which counts a weight once however
                // many agents hold it. This summed the holds instead — the
                // same error `admit()` carried, in a second place, which is
                // what one shared answer existing in two forms produces.
                held: residency.held(),
                holds: holds,
                // Thinned for transport. The full ring stays in memory for
                // anything in-process; what crosses a socket every tick does
                // not need six hundred readings to draw a line four hundred
                // pixels wide.
                samples: samples.history(WIRE_SAMPLES),
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
            // The domain's own figure, which counts a shared weight once.
            // Recomputing it here is how the two answers drifted apart.
            const held = residency.held()

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
         * Declare that something is reading the samples, and keep the fast
         * cadence while it is. Returns the release.
         *
         * Idempotent per caller only by contract — each `observe` must be
         * released exactly once, which is why it hands back a closure rather
         * than exposing the counter. Releasing twice would starve a sibling
         * watcher of the rate it asked for.
         */
        observe(): () => void {
            observers++
            samples.kick()
            let released = false
            return () => {
                if (released) return
                released = true
                observers = Math.max(0, observers - 1)
            }
        },

        /**
         * Declare from ACROSS THE SOCKET that something is drawing the
         * readings, for the next `ms`.
         *
         * The remote twin of `observe`, and deliberately not the same
         * mechanism — see `leasedUntil`. The caller renews on every tick, so
         * the lease need only outlive one interval; it is clamped because a
         * client asking to be watched for an hour would pin the cadence long
         * after it was gone.
         */
        watching(ms?: number): boolean {
            const span = Math.max(1_000, Math.min(30_000, Number(ms) || 3_000))
            leasedUntil = Date.now() + span
            // The pending tick may have been armed at the idle rate; without
            // this the first ten seconds of a freshly-opened panel are a
            // motionless line.
            samples.kick()
            return true
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
