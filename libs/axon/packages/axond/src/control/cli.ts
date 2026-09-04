import { Renderer, header, rows, status } from "@arcforge/arcline"
import { err, isAxonError, renderError } from "@arcforge/err"
import { AxonDaemon } from "../client"
import { Credential } from "../agents/index"
import type { Actor } from "../jobs/index"
import type { AxondT } from "../axond"

/**
 * How often a dictation frame is emitted while the microphone is open.
 *
 * ~16Hz: fast enough that a level meter reads as live, slow enough that it
 * costs nothing — the frame is about 300 bytes and reads only the audio file
 * the daemon is already writing. The full machine snapshot stays at its own
 * 500ms, because it is 47KB and does real work to build.
 */
const DICTATION_FRAME_MS = 60

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

    /**
     * Who is running this command — a person, or an agent shelling out.
     *
     * Resolved HERE rather than taken as a parameter: a caller that could
     * declare its own actor could declare itself human, and the whole point of
     * the mark is that an agent cannot acknowledge its own work. See
     * Credential.actor for exactly how strong that is.
     *
     * A command run by nobody signed in still creates jobs — the work is real
     * and the record should exist — so an unknown actor is recorded as an
     * agent named "anonymous" rather than being silently promoted to a person.
     * It can create and it cannot acknowledge, which is the safe direction.
     */
    const credential = Credential({})
    function actor(): Actor {
        return credential.actor() ?? { kind: "agent", session: "anonymous" }
    }
    const r = Renderer()

    /** Bytes as a human figure, or a dash where the figure is unknown. */
    function size(bytes: number | null): string {
        if (bytes === null || !Number.isFinite(bytes)) return "—"
        const units = ["B", "KB", "MB", "GB", "TB"]
        let value = bytes
        let i = 0
        while (value >= 1024 && i < units.length - 1) { value /= 1024; i++ }
        return `${i === 0 ? value.toFixed(0) : value.toFixed(value < 10 ? 1 : 0)}${units[i]}`
    }

    /**
     * A size a person typed, as bytes.
     *
     * Refuses rather than guessing: a ceiling silently read as 12 bytes
     * because the suffix was not understood would refuse every load, and the
     * user would have no way to see why.
     */
    function bytesFrom(input: string): number {
        const match = /^\s*(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb|k|m|g|t)?\s*$/i.exec(input)
        if (!match) {
            throw err("MACHINE_BUDGET_INVALID", {
                detail: `could not read "${input}" as a size — try 12GB, 8192MB, or a plain number of bytes`,
                context: { input },
            })
        }
        const scale: Record<string, number> = {
            b: 1, kb: 1024, k: 1024, mb: 1024 ** 2, m: 1024 ** 2,
            gb: 1024 ** 3, g: 1024 ** 3, tb: 1024 ** 4, t: 1024 ** 4,
        }
        return Math.floor(Number(match[1]) * (scale[(match[2] ?? "b").toLowerCase()] ?? 1))
    }

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
         * Read or declare the video-memory ceiling.
         *
         * `null` clears it and lets the measured hardware be the limit; zero is
         * a real declaration meaning nothing may load. Accepts bytes, or the
         * human forms a person actually types — a control that made someone
         * work out how many bytes are in twelve gigabytes would not be used.
         */
        budget(value?: string, json = false): string {
            if (value !== undefined) {
                opts.axond.machine.budget.set(value === "clear" ? null : bytesFrom(value))
            }

            const declared = opts.axond.machine.budget.current()
            const capacity = opts.axond.machine.hardware.current().vram
            if (json) return JSON.stringify({ budget: declared, vram: capacity })

            return declared === null
                ? status(r, "info", "no budget declared", capacity === null
                    ? "video memory is unmeasurable on this machine, so nothing bounds a load"
                    : `the card's ${size(capacity)} is the ceiling`)
                : status(r, "ok", `budget ${size(declared)}`, capacity === null ? "" : `of ${size(capacity)} installed`)
        },

        /**
         * Search what can be downloaded, across Hugging Face and Ollama.
         *
         * Named `catalog` rather than `search` because `axon search` already
         * means the artifact registry — agents, modules, cognets. Two things
         * called search that return different kinds of result is how a CLI
         * becomes guesswork.
         *
         * Cache-first, and rows come back marked with what this machine
         * already has, so a surface can offer "Remove" rather than "Download"
         * without a second lookup.
         */
        async catalog(
            query: string,
            capability?: string,
            json = false,
            page = false,
            sort?: string,
            fitsOnly = false,
        ): Promise<string> {
            const scoped = capability && capability !== "" && capability !== "all"
            const input = {
                query,
                ...(scoped ? { capability: capability as never } : {}),
                ...(sort ? { sort: sort as never } : {}),
                fitsOnly,
            }
            /*
             * Asked of the DAEMON when one is running.
             *
             * A catalogue row is stamped with how it sits against this machine
             * — cached, resident, whether it fits — and that stamp is read
             * from the daemon's in-memory list of what is on disk. A one-shot
             * process has never enumerated the disk, so every row came back
             * `cached: false` and a model already downloaded offered you a
             * download button.
             *
             * The search itself would have worked either way; the daemon's own
             * catalogue cache is on disk and shared. It is the LOCAL STATE that
             * only one process knows.
             */
            const live = opts.axond.lifecycle.status()
            const remote = live.running ? AxonDaemon() : null
            const found = remote
                ? (page ? await remote.models.more(input) : await remote.models.search(input))
                : (page ? await opts.axond.models.more(input) : await opts.axond.models.search(input))
            const more = remote
                ? await remote.models.hasMore(input)
                : opts.axond.models.hasMore(input)
            if (json) return JSON.stringify({ query, models: found, more: more })
            if (found.length === 0) return status(r, "info", "nothing found", query)

            return [
                header(r, { title: "catalog", subtitle: `${found.length} for "${query}"` }),
                "",
                ...rows(r, found.map(model => ({
                    label: model.name,
                    value: `${model.owner} · ${model.cached ? "on disk" : size(model.bytes)}`,
                    arrow: false,
                }))),
            ].join("\n")
        },

        /**
         * One model in full — its card, its weight files, its download count.
         *
         * Separate from `catalog` because a listing is deliberately thin: forty
         * rows each carrying a README would be a slow search to make one
         * detail page fast. This is what a detail page asks for once, after
         * something is selected.
         */
        async model(specifier: string, json = false): Promise<string> {
            const detail = await opts.axond.models.at(specifier)
            if (json) return JSON.stringify(detail)

            return [
                header(r, { title: detail.name, subtitle: detail.owner }),
                "",
                ...rows(r, [
                    { label: "source", value: detail.source, arrow: false },
                    { label: "capability", value: detail.capability, arrow: false },
                    { label: "runtime", value: detail.runtime ?? "none on this machine", arrow: false },
                    { label: "downloads", value: detail.downloads === null ? "—" : String(detail.downloads), arrow: false },
                    { label: "weights", value: String(detail.weights.length), arrow: false },
                ]),
            ].join("\n")
        },

        // ── Jobs ────────────────────────────────────────────────────────────

        /**
         * Delegate work to an agent.
         *
         * Through the RUNNING daemon whenever there is one, for the reason
         * `download` is: the agent this boots must outlive the command that
         * asked for it, and this process exits the moment the command returns.
         * Local is the honest fallback — the job is recorded and stays queued
         * until a daemon picks it up, which beats losing what a person typed
         * because nothing was listening.
         */
        async jobCreate(input: { content: string; title?: string; agent?: string; cwd?: string }, json = false): Promise<string> {
            const payload = {
                content: input.content,
                by: actor(),
                ...(input.title !== undefined ? { title: input.title } : {}),
                ...(input.agent !== undefined ? { agent: input.agent } : {}),
                ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
            }
            const live = opts.axond.lifecycle.status()
            const job = live.running
                ? await AxonDaemon().jobs.create(payload)
                : await opts.axond.jobs.create(payload)

            if (json) return JSON.stringify(job)
            return status(r, "ok", "job created", `${job.ref} · ${job.title}`)
        },

        /** Every job, or only the ones still wanting something. */
        async jobs(all = false, json = false): Promise<string> {
            const live = opts.axond.lifecycle.status()
            const jobs = live.running
                ? (all ? (await AxonDaemon().jobs.state()).jobs : await AxonDaemon().jobs.open())
                : (all ? opts.axond.jobs.list() : opts.axond.jobs.open())

            if (json) return JSON.stringify({ jobs: jobs })
            if (jobs.length === 0) return status(r, "info", all ? "no jobs" : "nothing open", "`axon job create -c \"...\"`")

            return [
                header(r, { title: "jobs", subtitle: `${jobs.length}` }),
                "",
                ...rows(r, jobs.map(job => ({
                    label: `${job.ref}  ${job.title}`,
                    value: job.acknowledged ? `${job.run} · done` : job.run,
                    arrow: false,
                }))),
            ].join("\n")
        },

        /** One job in full, with its thread. */
        async job(ref: string, json = false): Promise<string> {
            const live = opts.axond.lifecycle.status()
            const job = live.running ? await AxonDaemon().jobs.at(ref) : opts.axond.jobs.at(ref)
            if (!job) return status(r, "info", "no such job", ref)
            if (json) return JSON.stringify(job)

            return [
                header(r, { title: job.title, subtitle: `${job.ref} · ${job.run}${job.acknowledged ? " · done" : ""}` }),
                "",
                ...rows(r, [
                    { label: "agent", value: job.agent ?? "default", arrow: false },
                    { label: "where", value: job.cwd ?? "-", arrow: false },
                    { label: "session", value: job.session ?? "-", arrow: false },
                    ...(job.question ? [{ label: "waiting on", value: job.question, arrow: false }] : []),
                ]),
                "",
                ...job.events
                    .filter(event => event.kind === "created" || event.kind === "said")
                    .map(event => {
                        const who = event.by.kind === "human" ? "you" : "agent"
                        const text = event.kind === "created" ? event.content : (event as { text: string }).text
                        return `  ${who}  ${text}`
                    }),
            ].join("\n")
        },

        /** Add a turn. Answering a blocked job is what unblocks it. */
        async jobSay(ref: string, text: string, json = false): Promise<string> {
            const input = { ref: ref, text: text, by: actor() }
            const live = opts.axond.lifecycle.status()
            const job = live.running ? await AxonDaemon().jobs.say(input) : opts.axond.jobs.say(input)
            if (json) return JSON.stringify(job)
            return status(r, "ok", "said", `${job.ref} · ${job.run}`)
        },

        /** Mark it dealt with. A person's decision — an agent is refused. */
        async jobDone(ref: string, json = false): Promise<string> {
            const input = { ref: ref, by: actor() }
            const live = opts.axond.lifecycle.status()
            const job = live.running ? await AxonDaemon().jobs.acknowledge(input) : opts.axond.jobs.acknowledge(input)
            if (json) return JSON.stringify(job)
            return status(r, "ok", "done", `${job.ref} · ${job.title}`)
        },

        /** Stop it. A person's decision — an agent is refused. */
        async jobCancel(ref: string, json = false): Promise<string> {
            const input = { ref: ref, by: actor() }
            const live = opts.axond.lifecycle.status()
            const job = live.running ? await AxonDaemon().jobs.cancel(input) : opts.axond.jobs.cancel(input)
            if (json) return JSON.stringify(job)
            return status(r, "ok", "cancelled", job.ref)
        },

        /** Run it again on the same thread. A person's decision — an agent is refused. */
        async jobRetry(ref: string, json = false): Promise<string> {
            const input = { ref: ref, by: actor() }
            const live = opts.axond.lifecycle.status()
            const job = live.running ? await AxonDaemon().jobs.retry(input) : await opts.axond.jobs.retry(input)
            if (json) return JSON.stringify(job)
            return status(r, "ok", "retrying", `${job.ref} · ${job.run}`)
        },

        /**
         * What weights are on this machine, and which are loaded.
         *
         * The RUNNING daemon when there is one. `state()` is synchronous and
         * reports the last enumeration, so a one-shot process that has never
         * called `refresh()` reports an empty machine — and residency is the
         * daemon's memory besides, so "which are loaded" is only answerable
         * there. Local enumerates on demand, which is why it is async.
         */
        async models(json = false): Promise<string> {
            /*
             * Re-enumerate wherever the answer is coming FROM.
             *
             * `cached` is an in-memory view of the disk, and the daemon only
             * rebuilds it when something asks. A weight fetched by a one-shot
             * CLI — a different process writing the same store — left the
             * daemon reporting a cache that no longer matched its own index,
             * so a freshly downloaded model was invisible to every surface
             * reading through it. Refreshing locally while the daemon answered
             * refreshed the wrong process's copy.
             */
            const live = opts.axond.lifecycle.status()
            const remote = live.running ? AxonDaemon() : null
            if (remote) await remote.models.refresh()
            else await opts.axond.models.refresh()
            const state = remote
                ? await remote.models.state()
                : opts.axond.models.state()
            if (json) return JSON.stringify(state)
            if (state.cached.length === 0) return status(r, "info", "no models cached on this machine", state.root)

            return [
                header(r, { title: "models", subtitle: `${state.cached.length} cached · ${state.resident.length} loaded` }),
                "",
                ...rows(r, state.cached.map(model => ({
                    label: model.name,
                    value: `${model.resident ? "loaded" : "on disk"} · ${size(model.bytes)}`,
                    arrow: false,
                }))),
            ].join("\n")
        },

        /**
         * Fetch a weight to this machine's cache.
         *
         * `file` names the weight inside a repository that publishes several.
         * Omitted, the domain picks the conventional one and refuses rather
         * than guessing when there is no single obvious weight — which is a
         * real answer a surface should show, not an error to hide.
         */
        async fetch(specifier: string, file?: string, json = false): Promise<string> {
            const record = await opts.axond.models.fetch(file ? { specifier, file } : specifier)
            if (json) return JSON.stringify(record)
            return status(r, "ok", "fetched", `${record.name} · ${size(record.bytes)}`)
        },

        /**
         * Begin a download, and report where it went.
         *
         * Dispatched to the RUNNING daemon whenever there is one, which is the
         * whole point: a job started in this process dies when this process
         * exits, and this process exits the moment the command returns. Local
         * is the fallback, and it blocks — because with no daemon there is
         * nothing to outlive the caller anyway.
         */
        async download(specifier: string, file?: string, json = false): Promise<string> {
            const live = opts.axond.lifecycle.status()

            if (live.running) {
                const started = await AxonDaemon().models.download(specifier, file)
                if (json) return JSON.stringify({ ...started, detached: true })
                return status(r, "ok", "downloading", `${specifier} · ${started.id}`)
            }

            const record = await opts.axond.models.fetch(file ? { specifier, file } : specifier)
            if (json) return JSON.stringify({ id: null, detached: false, model: record })
            return status(r, "ok", "fetched", `${record.name} · ${size(record.bytes)}`,
            )
        },

        /** Every transfer in flight, and ones that recently ended. */
        async downloads(json = false): Promise<string> {
            const live = opts.axond.lifecycle.status()
            const running = live.running
                ? await AxonDaemon().models.downloads()
                : opts.axond.models.downloads()

            if (json) return JSON.stringify({ downloads: running })
            if (running.length === 0) return status(r, "info", "nothing downloading")

            return [
                header(r, { title: "downloads", subtitle: `${running.length}` }),
                "",
                ...rows(r, running.map(download => ({
                    label: download.model,
                    value: download.total
                        ? `${Math.round((download.received / download.total) * 100)}% · ${download.state}`
                        : download.state,
                    arrow: false,
                }))),
            ].join("\n")
        },

        /** Stop reporting a transfer. */
        async cancelDownload(id: string, json = false): Promise<string> {
            const live = opts.axond.lifecycle.status()
            const stopped = live.running
                ? await AxonDaemon().models.cancelDownload(id)
                : opts.axond.models.cancelDownload(id)

            if (json) return JSON.stringify({ cancelled: stopped, id })
            return stopped ? status(r, "ok", "cancelled", id) : status(r, "info", "not downloading", id)
        },

        /**
         * Delete a cached weight. Unloads it first — see models.remove.
         *
         * Dispatched to the RUNNING daemon for the same reason `download` is,
         * inverted: removal must UNLOAD before it deletes, and the holds live
         * in the daemon's memory, not this short-lived process's. Acting
         * locally deletes bytes the daemon still has mapped and leaves its
         * `cached` list — the one every surface renders — describing a file
         * that is gone.
         */
        async remove(model: string, json = false): Promise<string> {
            const live = opts.axond.lifecycle.status()
            const removed = live.running
                ? await AxonDaemon().models.remove(model)
                : await opts.axond.models.remove(model)
            if (json) return JSON.stringify({ removed, model })
            return removed
                ? status(r, "ok", "removed", model)
                : status(r, "info", "not cached on this machine", model)
        },

        /**
         * Load a cached weight into memory by hand, holding it for the person.
         *
         * The daemon whenever there is one, for the same reason `remove` is:
         * a hold taken in this process dies with it, which would be a load
         * that unloads itself the moment the command returns.
         */
        async pin(model: string, json = false): Promise<string> {
            const live = opts.axond.lifecycle.status()
            const loaded = live.running
                ? await AxonDaemon().models.pin(model)
                : await opts.axond.models.pin(model)

            if (json) return JSON.stringify({ loaded: loaded })
            return status(r, "ok", "loaded", `${loaded.name} · ${size(loaded.bytes)}`)
        },

        /**
         * `autoload` — whether running a model may load it first.
         *
         * With no argument it READS, the same shape as `budget`. On by
         * default: the panel's Try surface and a keybind both want "send it
         * and see", and making every first use a two-step is friction on the
         * one path that has to be frictionless.
         */
        async autoload(value?: string, json = false): Promise<string> {
            const live = opts.axond.lifecycle.status()
            const prefs = live.running ? AxonDaemon().preferences : opts.axond.preferences

            if (value === undefined) {
                const all = await prefs.all()
                const on = typeof all["autoload"] === "boolean" ? all["autoload"] as boolean : true
                if (json) return JSON.stringify({ autoload: on })
                return status(r, "info", "autoload", on ? "on" : "off")
            }

            const wanted = value === "on" || value === "true"
            if (!wanted && value !== "off" && value !== "false") {
                throw err("DAEMON_SETTING_INVALID", {
                    detail: `autoload takes on or off — got ${value}`,
                    context: { key: "autoload" },
                })
            }
            const set = await prefs.set({ key: "autoload", value: wanted })
            if (json) return JSON.stringify({ autoload: set })
            return status(r, "ok", "autoload", set ? "on" : "off")
        },

        /**
         * Any named preference, read or written — `preference <key> [value]`.
         *
         * `autoload` above is a verb of its own because it takes on/off rather
         * than a raw value and is documented in the help. Dictation adds a
         * hotkey, a capture mode and an engine name, and giving each of those
         * its own verb here — plus its own line in the CLI group, plus its own
         * setter in the panel — is the ladder `Preferences` was written to
         * refuse. One generic verb, and the panel names the key.
         *
         * ONE object in: this crosses the socket, where dispatch carries a
         * single argument, so a second positional would arrive `undefined`.
         */
        async preference(input: { key: string; value?: string }, json = false): Promise<string> {
            const live = opts.axond.lifecycle.status()
            const prefs = live.running ? AxonDaemon().preferences : opts.axond.preferences
            const key = input.key

            if (input.value === undefined) {
                const all = await prefs.all()
                const current = all[key]
                if (json) return JSON.stringify({ key: key, value: current ?? null })
                return status(r, "info", key, current === undefined ? "unset" : String(current))
            }

            // "true"/"false" become booleans so a switch written through this
            // verb reads back as one — `flag()` must never see the string.
            const value: string | boolean = input.value === "true" ? true
                : input.value === "false" ? false
                : input.value
            const set = await prefs.set({ key: key, value: value })
            if (json) return JSON.stringify({ key: key, value: set })
            return status(r, "ok", key, String(set))
        },

        /**
         * Stop one running agent.
         *
         * The daemon holds the registry and the process, so this reaches it
         * rather than acting locally — a one-shot process has no handle on
         * something another process started.
         */
        async stopAgent(sessionId: string, json = false): Promise<string> {
            const live = opts.axond.lifecycle.status()
            const stopped = live.running
                ? await AxonDaemon().agents.stop(sessionId)
                : await opts.axond.agents.stop(sessionId)
            if (json) return JSON.stringify({ stopped: stopped, sessionId })
            return stopped
                ? status(r, "ok", "stopped", sessionId)
                : status(r, "info", "was not running", sessionId)
        },

        /**
         * `dictate [start|stop|toggle|cancel|status]` — the verb a KEYBIND runs.
         *
         * Always reaches the running daemon and never falls back to an
         * in-process one, unlike every other verb here. That is the whole
         * point: a recording spans two keypresses, and the compositor launches
         * each as its own short-lived process. An in-process daemon would open
         * a microphone and take it to the grave microseconds later.
         *
         * Default is `toggle`, so the simplest possible Hyprland line —
         * `bind = SUPER ALT, D, exec, axon daemon dictate` — is a working
         * push-to-talk. Hold mode binds `start` to the press and `stop` to the
         * release instead.
         */
        async dictate(verb = "toggle", json = false): Promise<string> {
            const live = opts.axond.lifecycle.status()
            if (!live.running) {
                throw err("DAEMON_NOT_RUNNING", {
                    detail: "dictation needs the resident daemon — a recording spans two keypresses, "
                        + "so nothing short-lived can hold the microphone. Start it with `axon daemon up`.",
                })
            }
            const dictation = AxonDaemon().dictation

            if (verb === "status") {
                const state = await dictation.state()
                if (json) return JSON.stringify(state)
                if (state.blocked) return status(r, "warn", "dictation", state.blocked)
                return status(r, "info", "dictation",
                    (state.recording ? "recording" : "idle") + " · " + (state.model ?? "no model"))
            }

            if (verb === "start") {
                const state = await dictation.start()
                if (json) return JSON.stringify(state)
                return status(r, "ok", "recording", state.model ?? "")
            }

            if (verb === "cancel") {
                await dictation.cancel()
                if (json) return JSON.stringify({ recording: false, cancelled: true })
                return status(r, "ok", "cancelled", "")
            }

            if (verb === "stop") {
                const done = await dictation.stop()
                if (json) return JSON.stringify(done)
                return status(r, "ok", "typed", done.text || "(nothing was said)")
            }

            if (verb === "bind") {
                const result = await dictation.bind()
                if (json) return JSON.stringify(result)
                return result.bound
                    ? status(r, "ok", "bound", `${result.chord} (${result.mode})`)
                    : status(r, "info", "not bound", "no shortcut is set")
            }

            if (verb === "unbind") {
                await dictation.unbind()
                if (json) return JSON.stringify({ bound: false })
                return status(r, "ok", "unbound", "")
            }

            if (verb === "toggle") {
                const result = await dictation.toggle()
                if (json) return JSON.stringify(result)
                if (result.recording) return status(r, "ok", "recording", "")
                return status(r, "ok", "typed", result.dictated?.text || "(nothing was said)")
            }

            throw err("DAEMON_SETTING_INVALID", {
                detail: `dictate takes start, stop, toggle, cancel, status, bind or unbind — got ${verb}`,
                context: { key: "dictate" },
            })
        },

        /**
         * Run one inference against a resident weight.
         *
         * The verb the whole capability layer rests on: a keybind runs this,
         * the panel's Try surface runs this, and an agent asking the machine
         * for a transcript runs this. Deliberately NOT a load — an implicit
         * admission is a memory claim nobody made, so an unloaded weight is
         * told to load rather than loaded for you.
         *
         * `--json` emits the raw result, because a transcript, a vector and a
         * completion are different shapes and a formatter that guessed between
         * them would be wrong for two of the three.
         */
        async run(model: string, input: string, json = false): Promise<string> {
            const live = opts.axond.lifecycle.status()
            const request = { model: model, input: input }
            const result = live.running
                ? await AxonDaemon().models.run(request)
                : await opts.axond.models.run(request)

            if (json) return JSON.stringify({ model: model, result: result })
            return typeof result === "string" ? result : JSON.stringify(result, null, 2)
        },

        /** Release a loaded weight without deleting it. The hold is the daemon's, so this is too. */
        async unload(model: string, json = false): Promise<string> {
            const live = opts.axond.lifecycle.status()
            const released = live.running
                ? await AxonDaemon().models.unload(model)
                : await opts.axond.models.unload(model)
            if (json) return JSON.stringify({ unloaded: released, model })
            return released
                ? status(r, "ok", "unloaded", model)
                : status(r, "info", "was not loaded", model)
        },

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
                const remote = AxonDaemon()
                let stopped = false

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
                    } catch {
                        // The daemon went away mid-stream. Saying nothing is
                        // right: the consumer's own liveness check reports it,
                        // and a half-empty line would look like real readings.
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
                    } catch {
                        // Same reasoning as the full tick: a daemon that went
                        // away is reported by the consumer's own liveness check.
                    }
                }

                await opts.axond.models.refresh()
                await tick()
                const remoteTimer = setInterval(tick, intervalMs)
                const pulseTimer = setInterval(pulse, DICTATION_FRAME_MS)
                return () => {
                    stopped = true
                    clearInterval(remoteTimer)
                    clearInterval(pulseTimer)
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
            await opts.axond.models.refresh()

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
         * What the daemon sees of this machine.
         *
         * Read from the LOCAL handle rather than over the socket: `axond` may
         * be run when no daemon is listening, and "what does this box have"
         * is answerable either way. A figure that needed a running daemon to
         * report the hardware would be an odd thing to refuse.
         */
        machine(json = false): string {
            const state = opts.axond.machine.state()
            if (json) return JSON.stringify(state)
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
        agents(json = false): string {
            const running = opts.axond.agents.list()
            if (json) return JSON.stringify({ agents: running })
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
