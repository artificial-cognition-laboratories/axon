import type { CliContext } from "./types"
import { isAxonError } from "@arcforge/err"

/** WatchCommands owns the watch command surface. */
export function WatchCommands(opts: CliContext) {
    const DICTATION_FRAME_MS = 60

    return {

        /**
         * Stream this machine's state as NDJSON, one line per tick, until stopped.
         *
         * ── Why a stream and not a poll ─────────────────────────────────────
         *
         * The daemon already polls; a surface that polled the CLI would be a
         * second poller sampling a first one, at a cadence neither controls.
         * One long-lived process emitting a line per reading gives a watcher
         * the daemon's own tick, and a desktop panel consuming it needs no
         * timer of its own.
         *
         * ── Why it reads locally ────────────────────────────────────────────
         *
         * Everything here is readable without a socket: hardware is this box,
         * holds are files under `~/.axon/cache/resources`, agent records are
         * files, and the weight cache is a directory. That is the same
         * degraded path every other reader already takes, and it means a watch
         * keeps telling the truth while the daemon is down — which is exactly
         * when a surface most needs to say something.
         *
         * The one thing it cannot see is `models.state().resident`, which
         * lives in the serving process's memory. Holds carry the model they
         * were taken for, so residency is derivable from `machine.holds`, and
         * that is what a consumer should read.
         */
        async watch(emit: (line: string) => void, intervalMs = 500): Promise<() => void> {
            /*
             * Prefer the RUNNING daemon's readings over our own.
             *
             * A watch that samples locally starts with an empty ring, so every
             * time a panel was reopened its graphs began again from nothing —
             * the history belonged to a process that died with the panel. The
             * daemon has been sampling since boot; reading its state means a
             * surface opens onto however long the machine has been up.
             *
             * Local sampling stays as the fallback, because the daemon being
             * down must not mean a surface with nothing to say. It is the same
             * degraded path every other reader here takes.
             */
            const live = opts.axond.lifecycle.status()
            if (live.running) {
                const remote = opts.client
                let stopped = false
                let priming = true
                let remoteTimer: ReturnType<typeof setInterval> | undefined = undefined
                let pulseTimer: ReturnType<typeof setInterval> | undefined = undefined

                function fail(cause: unknown): void {
                    if (priming) throw cause
                    if (stopped) return
                    stopped = true
                    if (remoteTimer) clearInterval(remoteTimer)
                    if (pulseTimer) clearInterval(pulseTimer)
                    emit(JSON.stringify({
                        at: Date.now(),
                        error: {
                            ...(isAxonError(cause) ? { code: cause.code } : {}),
                            message: cause instanceof Error ? cause.message : String(cause),
                        },
                    }))
                    process.exitCode = 1
                }

                const tick = async () => {
                    if (stopped) return
                    try {
                        /*
                         * Tell the daemon someone is looking, before reading.
                         *
                         * Without this the daemon polls at its idle cadence
                         * while a panel draws a graph from it — the fast rate
                         * was only ever reached by a watcher sampling in its
                         * OWN process, which is the fallback path, not this
                         * one. Renewed per tick because it is a lease.
                         */
                        await remote.machine.watching(intervalMs * 3)
                        emit(JSON.stringify({
                            at: Date.now(),
                            daemon: opts.axond.lifecycle.status(),
                            boot: { supported: opts.axond.boot.unit().supported, installed: opts.axond.boot.installed() },
                            machine: await remote.machine.state(),
                            // Agents are file-backed, so reading them locally
                            // is correct and cheaper — every process sees the
                            // same records.
                            agents: opts.axond.agents.list(),
                            // Models are NOT: what is resident and what is
                            // downloading live in the serving process's memory,
                            // so a local read reports an empty machine while
                            // the daemon is holding weights and moving bytes.
                            models: await remote.models.state(),
                            // Jobs are the daemon's too: a job created in one
                            // process is visible from every surface, and a
                            // local read would report an empty list on a
                            // machine that has work queued.
                            jobs: (await remote.jobs.state()).jobs,
                            installed: await remote.agents.installed(),
                            identity: await remote.identity.read(),
                            preferences: await remote.preferences.all(),
                            /*
                             * Whether the microphone is open right now.
                             *
                             * On the STREAM rather than behind a verb because
                             * it is the one thing about dictation nobody can
                             * see: the feature deliberately has no window, so
                             * "is it listening" has no answer unless a surface
                             * is told continuously. Without this a person
                             * presses the key and stares at an unchanged
                             * screen, which is indistinguishable from a
                             * shortcut that never registered.
                             */
                            dictation: await remote.dictation.state(),
                        }))
                    } catch (cause) {
                        fail(cause)
                    }
                }

                /*
                 * ── A fast lane, for the one reading that is watched live ───
                 *
                 * The full snapshot is 47KB and costs a models read, a jobs
                 * read and a directory walk, so it ticks twice a second. That
                 * is right for "what is this machine doing" and hopeless for a
                 * voice meter: the visualiser moved in two steps per second and
                 * the listening indicator appeared up to 500ms after the
                 * microphone opened.
                 *
                 * So while a recording is open, dictation is emitted on its own
                 * at ~16Hz — about 300 bytes, no reads beyond the audio file
                 * already being written. A frame with no `machine` key is a
                 * PARTIAL: consumers merge it rather than replacing everything,
                 * which is what keeps one stream instead of two processes.
                 *
                 * It runs only while recording, so an idle machine pays
                 * nothing at all for it.
                 */
                let wasRecording = false
                async function pulse(): Promise<void> {
                    if (stopped) return
                    try {
                        const state = await remote.dictation.state()
                        // The first frame after the microphone opens is emitted
                        // immediately; that is the whole latency budget for the
                        // indicator appearing.
                        if (!state.recording && !wasRecording) return
                        wasRecording = state.recording
                        emit(JSON.stringify({ at: Date.now(), dictation: state }))
                    } catch (cause) {
                        fail(cause)
                    }
                }

                await opts.axond.models.refresh()
                await tick()
                priming = false
                remoteTimer = setInterval(tick, intervalMs)
                pulseTimer = setInterval(pulse, DICTATION_FRAME_MS)
                return () => {
                    stopped = true
                    if (remoteTimer) clearInterval(remoteTimer)
                    if (pulseTimer) clearInterval(pulseTimer)
                }
            }

            // Begin sampling in THIS process: the ring is per-process, and a
            // watcher that never started one would emit an empty history
            // forever.
            // BEFORE start(), not after. `Samples.start()` schedules its next
            // tick by asking `busy()` once, at that moment — so observing
            // afterwards leaves the first interval locked at the idle rate and
            // the panel waits ten seconds for its second data point.
            const release = opts.axond.machine.observe()
            opts.axond.machine.start()
            try {
                await opts.axond.models.refresh()
            } catch (cause) {
                release()
                opts.axond.machine.stop()
                throw cause
            }

            function snapshot(): string {
                return JSON.stringify({
                    at: Date.now(),
                    daemon: opts.axond.lifecycle.status(),
                    boot: { supported: opts.axond.boot.unit().supported, installed: opts.axond.boot.installed() },
                    machine: opts.axond.machine.state(),
                    agents: opts.axond.agents.list(),
                    models: opts.axond.models.state(),
                    jobs: opts.axond.jobs.list(),
                    installed: opts.axond.agents.installed(),
                    identity: opts.axond.identity.read(),
                    preferences: opts.axond.preferences.all(),
                })
            }

            emit(snapshot())
            const timer = setInterval(() => emit(snapshot()), intervalMs)

            return () => {
                clearInterval(timer)
                release()
                opts.axond.machine.stop()
            }
        },
    }
}

export type WatchCommandsT = ReturnType<typeof WatchCommands>
