import type { LiveProcHandle, ProcOutputStream, ProcQueryOptions, ProcStatus } from "../../../types"
import { extractFromBuffers, queryBuffers } from "./query"

/**
 * The mirror entry one managed child process is tracked by.
 * Mutated in place by the Procs registry as events arrive — handles hold a
 * reference and read live state through getters.
 */
export type ProcEntry = {
    procId: string
    kind: "managed" | "run"
    command: string
    pid?: number
    cwd?: string
    status: ProcStatus
    exitCode?: number
    /** Why the spawn was refused, when it was. Set with status `exited` and no pid. */
    error?: string
    stdout: string[]
    stderr: string[]
    startedAt: number
    endedAt?: number
}

/** Capabilities the registry lends a handle. */
export type ProcEntryImpl = {
    kill(): void
    stdin(data: string): void
    /**
     * Per-line listener for this procId. Two reserved keys carry lifecycle
     * rather than output: `procId + ":start"` fires once when the spawn
     * settles (launched or refused), `procId + ":exit"` once on exit.
     */
    subscribe(key: string, cb: (line: string) => void): () => void
}

function buildMatcher(match: string | RegExp): (line: string) => boolean {
    if (match instanceof RegExp) return line => match.test(line)
    const lower = match.toLowerCase()
    return line => line.toLowerCase().includes(lower)
}

/** Last N newline-terminated chunks of text, preserving trailing newlines. */
function lastNLines(text: string, n: number): string {
    if (!text) return ""
    const lines: string[] = []
    let start = 0
    for (let i = 0; i < text.length; i++) {
        if (text[i] === "\n") {
            lines.push(text.slice(start, i + 1))
            start = i + 1
        }
    }
    if (start < text.length) lines.push(text.slice(start))
    return lines.slice(-n).join("")
}

/** Wrap a mirror entry as the caller-facing live handle. */
export function wrapEntry(entry: ProcEntry, impl: ProcEntryImpl): LiveProcHandle {
    /**
     * Settled at wrap time so it is always safe to await right after spawn,
     * including on a handle wrapped from an entry that already settled.
     *
     * "Settled" means mediation finished and the OS answered — NOT that the
     * process finished. A refusal settles it too, with `ok: false` and the
     * reason, so a caller learns why rather than inferring it from a missing
     * pid.
     */
    const started = new Promise<{ ok: boolean; pid: number | undefined; err: string | undefined }>(resolve => {
        const settle = () => resolve({
            ok: entry.status === "running",
            pid: entry.pid,
            err: entry.error,
        })
        if (entry.status !== "pending") {
            settle()
            return
        }
        const off = impl.subscribe(entry.procId + ":start", () => {
            off()
            settle()
        })
    })

    // Created at wrap time so it's always safe to await right after spawn.
    const exited = new Promise<{ exitCode: number; ok: boolean; stdout: string }>(resolve => {
        if (entry.status === "exited") {
            resolve({ exitCode: entry.exitCode ?? -1, ok: entry.exitCode === 0, stdout: entry.stdout.join("") })
            return
        }
        const off = impl.subscribe(entry.procId + ":exit", () => {
            off()
            resolve({ exitCode: entry.exitCode ?? -1, ok: entry.exitCode === 0, stdout: entry.stdout.join("") })
        })
    })

    function buffered(include: ProcOutputStream[] = ["stdout"]): string {
        const parts: string[] = []
        if (include.includes("stdout")) parts.push(entry.stdout.join(""))
        if (include.includes("stderr")) parts.push(entry.stderr.join(""))
        return parts.join("")
    }

    const handle: LiveProcHandle = {
        get procId() { return entry.procId },
        get kind() { return entry.kind },
        get command() { return entry.command },
        get pid() { return entry.pid },
        get cwd() { return entry.cwd },
        get status() { return entry.status },
        get exitCode() { return entry.exitCode },
        get startedAt() { return entry.startedAt },
        get endedAt() { return entry.endedAt },

        kill: () => impl.kill(),
        stdin: data => impl.stdin(data),

        stdout: include => buffered(include === undefined ? undefined : Array.isArray(include) ? include : [include]),
        tail: (lines, include) => lastNLines(buffered(include), lines),
        query: (opts: ProcQueryOptions = {}) => queryBuffers(entry.procId, entry.stdout, entry.stderr, opts),
        extract: (regex, include) => extractFromBuffers(entry.stdout, entry.stderr, regex, include),

        started,
        exited,

        waitFor(pattern, opts) {
            const timeoutMs = opts?.timeoutMs ?? 30_000
            return new Promise((resolve, reject) => {
                const test = buildMatcher(pattern)

                // Already in the buffer?
                for (const chunk of entry.stdout) {
                    for (const line of chunk.split(/\r?\n/)) {
                        if (line && test(line)) {
                            resolve({ line, stdout: entry.stdout.join("") })
                            return
                        }
                    }
                }

                const timer = setTimeout(() => {
                    off()
                    exitOff()
                    reject(new Error(`waitFor() timed out after ${timeoutMs}ms for proc ${entry.procId}`))
                }, timeoutMs)

                const off = impl.subscribe(entry.procId, line => {
                    if (!test(line)) return
                    clearTimeout(timer)
                    off()
                    exitOff()
                    resolve({ line, stdout: entry.stdout.join("") })
                })

                const exitOff = impl.subscribe(entry.procId + ":exit", () => {
                    clearTimeout(timer)
                    off()
                    exitOff()
                    reject(new Error(`waitFor() — proc ${entry.procId} exited before pattern matched`))
                })
            })
        },

        on(match, cb) {
            const test = buildMatcher(match)
            return impl.subscribe(entry.procId, line => {
                if (test(line)) cb(line)
            })
        },

        async *watch(match) {
            const queue: string[] = []
            let notify: (() => void) | null = null
            let done = false

            const off = handle.on(match ?? /.?/, line => {
                queue.push(line)
                notify?.()
                notify = null
            })
            const exitOff = impl.subscribe(entry.procId + ":exit", () => {
                done = true
                notify?.()
                notify = null
            })

            try {
                while (true) {
                    if (queue.length > 0) {
                        yield queue.shift()!
                    } else if (done) {
                        break
                    } else {
                        await new Promise<void>(r => { notify = r })
                    }
                }
            } finally {
                off()
                exitOff()
            }
        },
    }

    return handle
}
