import { err } from "@arcforge/err"
import { header, rows, status } from "@arcforge/arcline"
import type { CliContext } from "./types"

/** CatalogCommands owns the catalog command surface. */
export function CatalogCommands(opts: CliContext) {
    const r = opts.renderer
    const size = opts.format.size

    return {

        /** Local execution backend environments installed under the Axon store. */
        runtimes(json = false): string {
            const runtimes = opts.axond.models.runtimes()
            if (json) return JSON.stringify({ runtimes: runtimes })
            return [
                header(r, { title: "local runtimes", subtitle: "Axon-managed" }),
                "",
                ...rows(r, runtimes.map(runtime => ({
                    label: runtime.id,
                    value: runtime.installed ? `installed · ${runtime.version}` : `not installed · ${runtime.version}`,
                    arrow: false,
                }))),
            ].join("\n")
        },

        /** Explicit only: downloading a model must never silently install native code. */
        async installRuntime(runtime: "onnx" | "llama.cpp" | "transformers", json = false): Promise<string> {
            const installed = await opts.axond.models.installRuntime(runtime)
            if (json) return JSON.stringify(installed)
            return status(r, "ok", `${installed.id} runtime installed`, installed.path)
        },

        async removeRuntime(runtime: "onnx" | "llama.cpp" | "transformers", json = false): Promise<string> {
            const removed = await opts.axond.models.removeRuntime(runtime)
            if (json) return JSON.stringify({ runtime, removed })
            return removed
                ? status(r, "ok", `${runtime} runtime removed`)
                : status(r, "info", `${runtime} runtime was not installed`)
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
            const selectedCapability = parseCapability(capability)
            const selectedSort = parseSort(sort)
            const input: SearchInput = {
                query: query,
                ...(selectedCapability ? { capability: selectedCapability } : {}),
                ...(selectedSort ? { sort: selectedSort } : {}),
                fitsOnly: fitsOnly,
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
            const remote = live.running ? opts.client : null
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
    }
}

export type CatalogCommandsT = ReturnType<typeof CatalogCommands>


type SearchInput = Exclude<Parameters<CliContext["axond"]["models"]["search"]>[0], string>

function parseCapability(input: string | undefined): SearchInput["capability"] {
    switch (input) {
        case undefined: case "": case "all": return undefined
        case "chat": case "speech": case "embedding": case "vision": case "other": return input
        default: throw err("MODEL_CATALOG_FILTER_INVALID", { detail: `unknown capability: ${input}`, context: { capability: input } })
    }
}

function parseSort(input: string | undefined): SearchInput["sort"] {
    switch (input) {
        case undefined: case "": return undefined
        case "relevance": case "downloads": case "size": case "recent": return input
        default: throw err("MODEL_CATALOG_FILTER_INVALID", { detail: `unknown sort: ${input}`, context: { sort: input } })
    }
}
