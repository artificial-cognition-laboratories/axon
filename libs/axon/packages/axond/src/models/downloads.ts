import { err } from "@arcforge/err"

/**
 * A transfer in flight, or one that recently ended.
 *
 * Kept as a record rather than a promise because the thing that STARTED a
 * download is almost never the thing watching it: a panel asks, closes, and
 * reopens expecting to find its download still going. A promise belongs to one
 * caller; this belongs to the machine.
 */
export type Download = {
    /** Opaque id, returned by `start` and required to cancel. */
    id: string
    /** The specifier asked for — `hf:owner/repo`. */
    model: string
    /** Which weight inside it, once resolved. Null while that is still being decided. */
    file: string | null
    requestedFile: string | null
    result: string | null
    /** Bytes on disk so far. */
    received: number
    /** Total bytes, when the server declares one. Null on a chunked transfer. */
    total: number | null
    state: DownloadState
    /** Why it failed, in the words the daemon used. Null otherwise. */
    error: string | null
    startedAt: number
    endedAt: number | null
}

export type DownloadState = "downloading" | "cancelling" | "done" | "failed" | "cancelled"

type DownloadsOpts = {
    /**
     * How long a finished download stays visible, ms.
     *
     * Long enough that someone who looked away sees it completed, short enough
     * that the list is about now. A failure keeps the same window: an error
     * nobody read is an error that did not happen.
     */
    keepMs?: number
}

/**
 * Downloads — every transfer this daemon is running, and how far along.
 *
 * ── Why the daemon owns these ───────────────────────────────────────────────
 *
 * A fetch used to run inside whichever CLI invocation asked for it. That
 * process is short-lived by design — a desktop panel spawns one per command
 * and reaps it when the surface closes — so closing the panel killed a
 * five-gigabyte transfer halfway through, silently, with a partial file left
 * for the store to reject later.
 *
 * A download is machine state, like a resident model or a running agent. It
 * belongs to the process that outlives every surface, which is the entire
 * reason the daemon exists.
 *
 * ── Nothing here awaits ─────────────────────────────────────────────────────
 *
 * `start` returns an id immediately and the transfer proceeds behind it.
 * Callers observe progress through `list()`, which rides the state the watch
 * stream already carries — so a panel gets live progress without a second
 * transport, and a panel that was closed the whole time still finds the result.
 */
export function Downloads(opts: DownloadsOpts = {}) {
    const keepMs = opts.keepMs ?? 60_000
    const active = new Map<string, Download>()
    const controllers = new Map<string, AbortController>()

    /** Drop finished records once nobody could reasonably still be reading them. */
    function reap(): void {
        const now = Date.now()
        for (const [id, download] of active) {
            if (download.endedAt !== null && now - download.endedAt > keepMs) active.delete(id)
        }
    }

    return {
        /**
         * Every transfer, newest first.
         *
         * Includes recently finished ones. A list that dropped a download the
         * instant it completed would flicker it out of existence at exactly
         * the moment someone looked up to see whether it had worked.
         */
        list(): Download[] {
            reap()
            return [...active.values()].sort((a, b) => b.startedAt - a.startedAt)
        },

        /** One transfer, or null. */
        at(id: string): Download | null {
            return active.get(id) ?? null
        },

        /**
         * Begin one, and hand back its id.
         *
         * `run` is the actual transfer, handed in rather than performed here:
         * this owns the RECORD of a download, and the models domain owns what
         * fetching means. Mixing the two would put registry knowledge inside a
         * progress tracker.
         */
        start(model: string, run: (report: (progress: { file?: string; received: number; total: number | null }) => void, signal: AbortSignal) => Promise<string | void>, file?: string): string {
            const id = `dl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

            const controller = new AbortController()
            controllers.set(id, controller)
            const download: Download = {
                id,
                model,
                file: null,
                requestedFile: file ?? null,
                result: null,
                received: 0,
                total: null,
                state: "downloading",
                error: null,
                startedAt: Date.now(),
                endedAt: null,
            }
            active.set(id, download)

            void run(progress => {
                // Ignore progress after the acquisition signal is aborted.
                if (controller.signal.aborted) return
                if (progress.file !== undefined) download.file = progress.file
                download.received = progress.received
                download.total = progress.total
            }, controller.signal)
                .then(result => {
                    download.result = typeof result === "string" ? result : null
                    download.state = "done"
                    download.endedAt = Date.now()
                })
                .catch((cause: unknown) => {
                    if (controller.signal.aborted) { download.state = "cancelled"; download.endedAt = Date.now(); return }
                    download.state = "failed"
                    download.error = cause instanceof Error ? cause.message : String(cause)
                    download.endedAt = Date.now()
                })
                .finally(() => controllers.delete(id))

            return id
        },

        /**
         * Abort a transfer.
         *
         * Acquisition receives the signal and refuses to publish a cancelled model.
         */
        cancel(id: string): boolean {
            const download = active.get(id)
            if (!download) return false
            if (download.state !== "downloading") return false

            const controller = controllers.get(id)
            if (!controller) throw err("MODEL_RUN_FAILED", { detail: "active download has no cancellation controller" })
            download.state = "cancelling"
            controller.abort()
            return true
        },

        /** Forget a finished record now, rather than waiting for it to age out. */
        dismiss(id: string): boolean {
            const download = active.get(id)
            if (!download || (download.state === "downloading" || download.state === "cancelling")) return false
            return active.delete(id)
        },

        /** Refuse a second transfer of something already in flight. */
        inFlight(model: string): Download | null {
            for (const download of active.values()) {
                if (download.model === model && (download.state === "downloading" || download.state === "cancelling")) return download
            }
            return null
        },
    }
}

export type DownloadsT = ReturnType<typeof Downloads>

/** Thrown when a caller asks for something already downloading. */
export function alreadyRunning(model: string): never {
    throw err("MODEL_DOWNLOAD_RUNNING", {
        detail: `${model} is already downloading`,
        context: { model },
    })
}
