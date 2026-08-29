import { Renderer, header, rows, status } from "@arcforge/arcline"
import { isAxonError, renderError } from "@arcforge/err"
import type { AxondT } from "../axond"

type CliOpts = {
    /** The daemon this CLI drives. Handed in so the CLI never builds its own. */
    axond: AxondT
}

/**
 * The daemon's own command surface.
 *
 * ── Why the daemon owns a CLI ───────────────────────────────────────────────
 *
 * `up`, `down` and `status` are what a caller runs when NO daemon is
 * listening, so they cannot live behind the socket. They also have to be
 * reachable as a BINARY — a systemd unit or a launchd plist execs an
 * executable, not a subcommand of something else.
 *
 * `axon daemon <verb>` is the same code: the main CLI holds an `Axond()` and
 * calls these, rather than reimplementing "spawn it and wait for a socket".
 * One implementation, two entry points.
 *
 * Every verb returns its output as a STRING rather than printing, so it can be
 * snapshot-tested and composed — the same rule arcline's own views follow.
 */
export function Cli(opts: CliOpts) {
    const r = Renderer()

    return {
        /**
         * Start a detached daemon, or report the one already running.
         *
         * `json` is what a PROGRAM calls — the Fleet extension starts the
         * daemon this way rather than spawning it itself, so there is one
         * implementation of "bring it up" and one place the ready-wait lives.
         * A machine-readable answer is the difference between a caller that
         * can act on the result and one parsing a tick.
         */
        async up(json = false): Promise<string> {
            const started = await opts.axond.lifecycle.up()

            /**
             * First `up` arranges for every subsequent boot.
             *
             * Silent, because the daemon is meant to be invisible — a person
             * running an agent should not have to know a supervisor exists.
             * Bounded by living entirely in the user's own home and by
             * `daemon disable` removing it completely.
             *
             * After the start, not before: a daemon that cannot run is not one
             * to arrange a boot for, and installing first would leave a unit
             * behind for something that never worked.
             */
            opts.axond.boot.install()
            if (json) return JSON.stringify(started)

            return started.already
                ? status(r, "ok", "axond is already running", `pid ${started.pid}`)
                : status(r, "ok", "axond started", `pid ${started.pid} · ${started.socket}`)
        },

        /** Stop the running daemon. Saying so when there was none is the honest answer. */
        down(): string {
            return opts.axond.lifecycle.down()
                ? status(r, "ok", "axond stopped")
                : status(r, "info", "axond is not running")
        },

        /** Whether a daemon is up, and what it is. */
        status(): string {
            const state = opts.axond.lifecycle.status()
            if (!state.running) return status(r, "info", "axond is not running", "start it with `axon daemon up`")

            return [
                header(r, { title: "axond", subtitle: `v${state.version}` }),
                "",
                ...rows(r, [
                    { label: "pid", value: String(state.pid), arrow: false },
                    { label: "uptime", value: duration(state.uptime), arrow: false },
                    { label: "socket", value: state.socket, arrow: false },
                ]),
            ].join("\n")
        },

        /**
         * Stop the daemon starting with the machine.
         *
         * The way out that makes a silent install defensible. Does NOT stop a
         * running daemon — "do not start next time" and "stop now" are
         * different asks, and collapsing them would make this the only way to
         * turn off boot AND take the machine's agents down with it.
         */
        disable(): string {
            const unit = opts.axond.boot.unit()
            if (!unit.supported) {
                return status(r, "info", "boot start is not supported on this platform")
            }

            opts.axond.boot.disable()
            return status(r, "ok", "axond will no longer start with this machine", "`axon daemon up` still starts it")
        },

        /**
         * What the daemon sees of this machine.
         *
         * Read from the LOCAL handle rather than over the socket: `axond` may
         * be run when no daemon is listening, and "what does this box have"
         * is answerable either way. A figure that needed a running daemon to
         * report the hardware would be an odd thing to refuse.
         */
        machine(): string {
            const state = opts.axond.machine.state()
            const vram = state.capacity.vram

            return [
                header(r, { title: state.identity.hostname, subtitle: state.identity.id ?? "unidentified" }),
                "",
                ...rows(r, [
                    { label: "platform", value: `${state.identity.platform}/${state.identity.arch}`, arrow: false },
                    { label: "cores", value: String(state.capacity.cores), arrow: false },
                    { label: "memory", value: `${bytes(state.usage.ramAvailable)} free of ${bytes(state.capacity.ram)}`, arrow: false },
                    { label: "gpu", value: state.capacity.gpu ?? "none detected", arrow: false },
                    {
                        label: "vram",
                        // Unmeasured is a real answer, and a different one from
                        // "zero" — a machine we cannot probe has no known
                        // ceiling rather than no memory.
                        value: vram === null
                            ? "unmeasured"
                            : `${bytes(state.usage.vramUsed ?? state.held)} used of ${bytes(vram)}`,
                        arrow: false,
                    },
                    { label: "load", value: state.usage.load.toFixed(2), arrow: false },
                    { label: "held", value: `${bytes(state.held)} across ${state.holds.length} ${state.holds.length === 1 ? "hold" : "holds"}`, arrow: false },
                ]),
            ].join("\n")
        },

        /**
         * Every agent running on this machine.
         *
         * Read from the LOCAL handle for the same reason `machine` is: the
         * registry is files on disk, so "what is running" is answerable
         * whether or not a daemon happens to be listening. That is the
         * degraded path working, not a shortcut around the socket.
         */
        agents(): string {
            const running = opts.axond.agents.list()
            if (running.length === 0) return status(r, "info", "no agents running on this machine")

            return [
                header(r, { title: "agents", subtitle: `${running.length} running` }),
                "",
                ...rows(r, running.map(agent => ({
                    label: agent.agentName,
                    value: `${agent.sessionId.slice(0, 8)}  pid ${agent.pid}`,
                    arrow: false,
                }))),
            ].join("\n")
        },

        /**
         * Become the daemon. Does not return until it is shut down.
         *
         * The one verb that is not a report — `bin/axond.ts serve` is what a
         * detached start execs, and what a service manager supervises.
         */
        async serve(): Promise<void> {
            await opts.axond.serve()

            // Both signals, because both mean "stop": SIGTERM is what `down`
            // and a service manager send, SIGINT is a person pressing ^C on a
            // foreground daemon. Neither may leave a socket behind for the
            // next start to trip over.
            const stop = (): void => {
                void opts.axond.shutdown().then(() => process.exit(0))
            }
            process.on("SIGTERM", stop)
            process.on("SIGINT", stop)
        },

        /** One line per verb — what `axond` with no argument prints. */
        help(): string {
            return [
                header(r, { title: "axond", subtitle: "the Axon daemon" }),
                "",
                ...rows(r, [
                    { label: "up", value: "start the daemon" },
                    { label: "down", value: "stop it" },
                    { label: "status", value: "is it running" },
                    { label: "machine", value: "what this box has, and what is held" },
                    { label: "agents", value: "what is running here" },
                    { label: "disable", value: "stop starting with the machine" },
                    { label: "serve", value: "become the daemon (foreground)" },
                ]),
            ].join("\n")
        },

        /**
         * Render a failure the way the rest of the platform does.
         *
         * An AxonError carries a code and a description a person can act on;
         * anything else is ours and gets reported as-is rather than dressed up
         * as something the user did.
         */
        failure(cause: unknown): string {
            return isAxonError(cause) ? renderError(cause) : String(cause)
        },
    }
}

export type CliT = ReturnType<typeof Cli>

/** Bytes as a short human figure. Pure. */
function bytes(value: number): string {
    if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)}GB`
    if (value >= 1024 ** 2) return `${Math.round(value / 1024 ** 2)}MB`
    return `${value}B`
}

/** Seconds as "2h 32m". Pure — string in, string out. */
function duration(seconds: number): string {
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    if (hours > 0) return `${hours}h ${minutes}m`
    if (minutes > 0) return `${minutes}m`
    return `${seconds}s`
}
