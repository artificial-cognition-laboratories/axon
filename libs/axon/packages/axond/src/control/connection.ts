import { errorMap, isAxonError } from "@arcforge/err"

type ConnectionOpts = {
    /**
     * Bring a CURRENT daemon up: start one if none is running, replace one
     * from an older build. Idempotent and cheap when the daemon is already
     * current — it reads a pidfile.
     *
     * Supplied by the host because only the host knows which build it is and
     * where its daemon binary lives: the CLI and TUI run their own
     * `MachineAxond().lifecycle.up()`, Fleet shells out to the installed
     * `axon daemon up`. Absent, verbs fail with DAEMON_NOT_RUNNING — honest
     * for a client that has no business starting anything.
     */
    launch?: () => Promise<void>
}

/**
 * Connection — the one place a client decides it can reach a daemon.
 *
 * Every consumer used to answer this itself, and each answered it
 * differently: the TUI's model path probed a protocol number and string-matched
 * an error message, the CLI replaced stale daemons, Fleet tried exactly once
 * per editor session and then reported "no daemon" forever, and the labs
 * clients did not try at all. So whether a request started the daemon depended
 * on which surface happened to make it.
 *
 * The contract now, for every verb on every surface:
 *
 *   first request    launch() once — starts a daemon, or replaces a stale one
 *                    left behind by `axon update` — then the verb
 *   daemon vanished  a refused connection relaunches once and retries; it is
 *                    the only failure safe to retry, because nothing was sent
 *   launch failed    the failure is the answer for COOLDOWN_MS, then retried.
 *                    A poll loop must not spawn a process every tick, and must
 *                    not be told "fine" either
 */
export function Connection(opts: ConnectionOpts) {
    const COOLDOWN_MS = 10_000

    let launched: Promise<void> | null = null
    let failure: { error: unknown; until: number } | null = null

    function ensure(): Promise<void> {
        if (!opts.launch) return Promise.resolve()
        if (failure !== null && Date.now() < failure.until) return Promise.reject(failure.error)
        if (launched === null) {
            const launch = opts.launch
            launched = launch().then(
                () => { failure = null },
                (error: unknown) => {
                    launched = null
                    failure = { error: error, until: Date.now() + COOLDOWN_MS }
                    throw error
                },
            )
        }
        return launched
    }

    async function through<T>(work: () => Promise<T>): Promise<T> {
        await ensure()
        try {
            return await work()
        } catch (cause) {
            if (!opts.launch || !notRunning(cause)) throw cause
            // The daemon this client reached is gone — crashed, stopped, or
            // replaced. Forget it and bring one up again, once.
            launched = null
            await ensure()
            return work()
        }
    }

    return {
        /** Bring the daemon up now, without a verb. A host warming up at start. */
        ensure: ensure,
        /** Run one request against a daemon that is up, relaunching once if it vanished. */
        through: through,
    }
}

export type ConnectionT = ReturnType<typeof Connection>

function notRunning(cause: unknown): boolean {
    return isAxonError(cause) && cause.code === errorMap.DAEMON_NOT_RUNNING.code
}
