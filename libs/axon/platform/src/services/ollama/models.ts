import { err } from "@arcforge/err"
import type { HttpT } from "./http"
import type { LocalModel, PullProgress, RunningModel } from "./types"

type TagsResponse = {
    models?: Array<{
        name: string
        size: number
        digest: string
        modified_at: string
        details?: { family?: string; parameter_size?: string; quantization_level?: string }
    }>
}

type PsResponse = {
    models?: Array<{ name: string; size: number; expires_at: string }>
}

type PullEvent = {
    status: string
    /** Layer identity — the key progress is accumulated against. */
    digest?: string
    total?: number
    completed?: number
    error?: string
}

type ModelsOpts = {
    http: HttpT
}

/**
 * Models — what is on this machine.
 *
 * Ollama owns the bytes. It keeps its own blob store under ~/.ollama/models,
 * deduplicates layers across tags, and garbage-collects on delete — so this
 * deliberately manages nothing on disk. Reimplementing that would mean a second
 * store competing with the one `ollama pull` already writes to.
 */
export function Models(opts: ModelsOpts) {
    const http = opts.http

    return {
        /** Every model on disk, largest first — the order a user reclaiming space wants. */
        async list(): Promise<LocalModel[]> {
            const response = await http.json<TagsResponse>("/api/tags")

            return (response.models ?? [])
                .map(entry => ({
                    name: entry.name,
                    size: entry.size,
                    digest: entry.digest,
                    modifiedAt: entry.modified_at,
                    family: entry.details?.family ?? "unknown",
                    parameters: entry.details?.parameter_size ?? "unknown",
                    quantization: entry.details?.quantization_level ?? "unknown",
                }))
                .sort((a, b) => b.size - a.size)
        },

        /** Whether this exact name is on disk. A bare name matches its `:latest` tag. */
        async has(name: string): Promise<boolean> {
            const qualified = name.includes(":") ? name : `${name}:latest`
            return (await this.list()).some(model => model.name === qualified)
        },

        /** Models resident in memory right now — a subset of what is downloaded. */
        async running(): Promise<RunningModel[]> {
            const response = await http.json<PsResponse>("/api/ps")

            return (response.models ?? []).map(entry => ({
                name: entry.name,
                size: entry.size,
                expiresAt: entry.expires_at,
            }))
        },

        /** Total bytes Ollama is holding on disk. */
        async usage(): Promise<{ count: number; bytes: number }> {
            const models = await this.list()
            return {
                count: models.length,
                bytes: models.reduce((total, model) => total + model.size, 0),
            }
        },

        /**
         * Download a model, yielding progress as it goes.
         *
         * Ollama reports NDJSON: a manifest phase with no sizes, then per-layer
         * byte counts, then verification. `percent` is null until the first
         * total arrives, because a progress bar that starts at 0% and sits
         * there is worse than one that admits it does not know yet.
         *
         * Consuming the generator IS the download — abandoning it early cancels
         * the request. A partially pulled model leaves no usable tag; the next
         * attempt resumes from Ollama's own layer cache.
         */
        async *pull(name: string, signal?: AbortSignal): AsyncGenerator<PullProgress> {
            // Progress is tracked ACROSS layers, not within one. Ollama reports
            // a fresh total/completed pair per layer, so reading the newest pair
            // alone makes percent hit 1 and snap back to near-zero every time a
            // layer finishes — five times for a small model. Summing per-digest
            // gives one monotonic number over the whole download.
            const layers = new Map<string, { total: number; completed: number }>()

            for await (const event of http.stream<PullEvent>("/api/pull", { model: name, stream: true })) {
                if (signal?.aborted) return

                // Ollama reports a failed pull in-band, on a 200 stream — an
                // unknown model arrives here, not as an HTTP error.
                if (event.error) {
                    throw err("OLLAMA_PULL_FAILED", {
                        detail: `${name}: ${event.error}`,
                        context: { model: name },
                    })
                }

                if (event.digest && event.total !== undefined) {
                    layers.set(event.digest, {
                        total: event.total,
                        completed: event.completed ?? layers.get(event.digest)?.completed ?? 0,
                    })
                }

                let total = 0
                let completed = 0
                for (const layer of layers.values()) {
                    total += layer.total
                    completed += layer.completed
                }

                const done = event.status === "success"
                yield {
                    status: event.status,
                    ...(total > 0 ? { total: total } : {}),
                    ...(total > 0 ? { completed: completed } : {}),
                    // Null until the first layer size arrives: a bar that sits
                    // at 0% is worse than one that admits it does not know yet.
                    percent: done ? 1 : total > 0 ? Math.min(completed / total, 1) : null,
                    done: done,
                }
            }
        },

        /** Remove a model. Ollama reclaims any layer no remaining tag references. */
        async remove(name: string): Promise<void> {
            await http.json("/api/delete", { model: name })
        },
    }
}

export type ModelsT = ReturnType<typeof Models>
