import { header, rows, status } from "@arcforge/arcline"
import { err, isAxonError, renderError } from "@arcforge/err"
import type { CliContext } from "./types"

/** Lifetime owns the lifetime command surface. */
export function Lifetime(opts: CliContext) {
    const r = opts.renderer
    const duration = opts.format.duration

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

        /**
         * Whether the daemon starts with the machine, and set it either way.
         *
         * `boot` with no argument reports; `on` and `off` install and remove
         * the unit. The install is otherwise silent and happens on first `up`,
         * which is defensible only because there is a way to see it and undo
         * it — this is that way.
         */
        boot(value?: string, json = false): string {
            if (value === "on") opts.axond.boot.install()
            if (value === "off") opts.axond.boot.disable()

            const unit = opts.axond.boot.unit()
            const installed = opts.axond.boot.installed()
            if (json) return JSON.stringify({ supported: unit.supported, installed, path: unit.path })

            if (!unit.supported) return status(r, "info", "boot start is not supported on this platform")
            return installed
                ? status(r, "ok", "axond starts with this machine", unit.path)
                : status(r, "info", "axond does not start with this machine", "`axon daemon boot on` arranges it")
        },

        /**
         * Whether a daemon is up, and what it is.
         *
         * `--json` is a GLOBAL flag on this CLI, documented as "one line of
         * JSON on stdout, nothing else". These inspection verbs rendered for a
         * human regardless, so a program that trusted the contract parsed a
         * table — and every consumer that wants this daemon's state is a
         * program. The rendered form stays the default; the machine-readable
         * one is the same state object the domain already returns, so the two
         * can never describe different things.
         */
        status(json = false): string {
            const state = opts.axond.lifecycle.status()
            if (json) return JSON.stringify(state)
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
                void opts.axond.shutdown().then(
                    () => process.exit(0),
                    cause => {
                        console.error(renderError(err(cause)))
                        process.exit(1)
                    },
                )
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

export type LifetimeT = ReturnType<typeof Lifetime>
