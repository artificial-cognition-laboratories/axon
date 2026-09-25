import { err } from "@arcforge/err"
import { header, rows, status } from "@arcforge/arcline"
import type { CliContext } from "./types"

/** ModelCommands owns the models command surface. */
export function ModelCommands(opts: CliContext) {
    const r = opts.renderer
    const size = opts.format.size

    return {

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
            const remote = live.running ? opts.client : null
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
                const started = await opts.client.models.download(specifier, file)
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
                ? await opts.client.models.downloads()
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
                ? await opts.client.models.cancelDownload(id)
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
                ? await opts.client.models.remove(model)
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
                ? await opts.client.models.pin(model)
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
            const prefs = live.running ? opts.client.preferences : opts.axond.preferences

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
                ? await opts.client.models.run(request)
                : await opts.axond.models.run(request)

            if (json) return JSON.stringify({ model: model, result: result })
            return typeof result === "string" ? result : JSON.stringify(result, null, 2)
        },

        /** Release a loaded weight without deleting it. The hold is the daemon's, so this is too. */
        async unload(model: string, json = false): Promise<string> {
            const live = opts.axond.lifecycle.status()
            const released = live.running
                ? await opts.client.models.unload(model)
                : await opts.axond.models.unload(model)
            if (json) return JSON.stringify({ unloaded: released, model })
            return released
                ? status(r, "ok", "unloaded", model)
                : status(r, "info", "was not loaded", model)
        },
    }
}

export type ModelCommandsT = ReturnType<typeof ModelCommands>
