import { err } from "@arcforge/err"
import type { AxonTestEventFrame } from "@arcforge/types"
import { isFrame, isTestChannel } from "./frames"

/** How long a SIGTERM is given to land before SIGKILL. */
const KILL_GRACE_MS = 1_000

/** How long to wait for the child's IPC channel to close after it exits. */
const DISCONNECT_GRACE_MS = 100

/**
 * The instrumented preload, resolved to an absolute path.
 *
 * Lives in bin/ because it is loaded into a DIFFERENT process — `bun test
 * --preload` — and is never imported by this one. Packaged builds ship it as a
 * sibling .js (see the TUI's vterm.config.ts); a source checkout runs the .ts.
 */
const PRELOAD = new URL("../../bin/test-preload.ts", import.meta.url).pathname

export type ChildOutcome = {
    exitCode: number
    stdout: string
    stderr: string
    /** True when the run was aborted rather than finishing on its own. */
    cancelled: boolean
}

type ChildOpts = {
    cwd: string
    env?: Record<string, string | undefined>
    timeoutMs?: number
    /** Extra preloads the child loads AFTER instrumentation. */
    preloads?: string[]
    /** A well-formed test frame arrived. */
    onFrame: (frame: AxonTestEventFrame) => void
    /** A message on the test channel that is not a valid frame — a protocol fault. */
    onInvalid: () => void
    /** Every IPC message, valid or not. Domain extensions read their own channels. */
    onMessage?: (message: unknown) => void
}

/**
 * Child — one `bun test` subprocess, watched.
 *
 * Owns the process boundary completely: argument construction, environment,
 * IPC decoding, and the SIGTERM→SIGKILL escalation an abort needs. The runner
 * above it never touches Bun.spawn.
 *
 * One file per child, `--max-concurrency 1`. Test files mutate global state
 * (the instrumented bun:test API is installed per-process), so a shared child
 * would interleave two files' events into one ambiguous stream.
 */
export function Child(opts: ChildOpts) {
    /**
     * `bun test foo.bench.ts` treats a non-.test/.spec name as a FILTER rather
     * than a path. An explicit relative prefix opts into arbitrary filenames,
     * which benchmark suites deliberately use.
     */
    function argsFor(file: string): string[] {
        const args = ["bun", "test", "--preload", PRELOAD, "--max-concurrency", "1"]
        if (opts.timeoutMs !== undefined) args.push("--timeout", String(opts.timeoutMs))
        args.push(file.startsWith(".") || file.startsWith("/") ? file : `./${file}`)
        return args
    }

    /** process.env with overrides applied, minus anything explicitly unset. */
    function envFor(file: string): Record<string, string> {
        const merged: Record<string, string> = {}
        const source = {
            ...process.env,
            ...opts.env,
            AXON_TEST_FILE: file,
            AXON_TEST_EXTENSION_PRELOADS: JSON.stringify(opts.preloads ?? []),
        }
        for (const [key, value] of Object.entries(source)) {
            if (value !== undefined) merged[key] = value
        }
        return merged
    }

    return {
        /** Run one file to completion. Resolves once the process has exited and its output is drained. */
        async run(file: string, signal?: AbortSignal): Promise<ChildOutcome> {
            let cancelled = signal?.aborted ?? false

            let disconnect!: () => void
            const disconnected = new Promise<void>(resolve => { disconnect = resolve })

            const child = Bun.spawn(argsFor(file), {
                cwd: opts.cwd,
                env: envFor(file),
                stdin: "ignore",
                stdout: "pipe",
                stderr: "pipe",
                ipc(message) {
                    opts.onMessage?.(message)

                    if (isFrame(message)) {
                        opts.onFrame(message.frame)
                        return
                    }
                    // Only a malformed message ON OUR CHANNEL is a fault. An
                    // extension's own traffic is none of this runner's business.
                    if (isTestChannel(message)) opts.onInvalid()
                },
                onDisconnect: disconnect,
            })

            let force: ReturnType<typeof setTimeout> | undefined
            const abort = () => {
                cancelled = true
                child.kill("SIGTERM")
                // A test blocked in native code will not answer SIGTERM. Escalate
                // rather than leaving an orphan holding the terminal.
                force = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS)
            }
            signal?.addEventListener("abort", abort, { once: true })

            // Start draining BEFORE awaiting exit: a child that fills the pipe
            // buffer blocks on write and never exits.
            const stdout = new Response(child.stdout).text()
            const stderr = new Response(child.stderr).text()

            try {
                const exitCode = await child.exited
                // IPC frames can still be in flight when the process exits —
                // wait briefly for the channel to close so the last events are
                // not dropped, but never hang on a child that already died.
                await Promise.race([disconnected, Bun.sleep(DISCONNECT_GRACE_MS)])

                return {
                    exitCode: exitCode,
                    stdout: await stdout,
                    stderr: await stderr,
                    cancelled: cancelled,
                }
            } finally {
                if (force) clearTimeout(force)
                signal?.removeEventListener("abort", abort)
            }
        },
    }
}

export type ChildT = ReturnType<typeof Child>

/** The protocol fault a malformed frame produces — one shape, one place. */
export function invalidFrameError() {
    return err("UNKNOWN", { detail: "test child sent an invalid IPC frame" })
}
