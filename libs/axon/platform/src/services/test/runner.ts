import { err } from "@arcforge/err"
import { Child, invalidFrameError } from "./child"
import { Events } from "./events"
import { resolveTestFiles } from "./files"
import type { TestRunOptions, TestRunResult } from "./types"

/**
 * TestRunner — native Bun test execution, projected into a structured event
 * stream.
 *
 * The point is not to reimplement a test runner. Bun already runs the tests;
 * this makes the run OBSERVABLE — every suite, case, hook and console line
 * arrives as an event on the same log the runtime writes to, so one session
 * shows a request and the tests that covered it in one ordered timeline.
 *
 * Composition only. The concerns underneath it:
 *   files   glob and path resolution
 *   child   one `bun test` subprocess, watched (spawn, IPC, abort)
 *   events  the authoritative ordered stream, liveness and delivery
 *
 * Files run sequentially. The instrumented bun:test API is installed
 * per-process, so two files sharing a child would interleave into one
 * ambiguous stream.
 */
export function TestRunner() {
    return {
        async run(options: TestRunOptions): Promise<TestRunResult> {
            const cwd = options.cwd ?? process.cwd()
            const files = await resolveTestFiles(options.files, cwd)
            if (files.length === 0) throw err("TEST_FILES_NOT_FOUND")

            const runId = Bun.randomUUIDv7()
            const startedAt = performance.now()

            const events = Events({
                runId: runId,
                ...(options.onEvent ? { onEvent: options.onEvent } : {}),
            })

            const child = Child({
                cwd: cwd,
                ...(options.env ? { env: options.env } : {}),
                ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
                ...(options.preloads ? { preloads: options.preloads } : {}),
                ...(options.onMessage ? { onMessage: options.onMessage } : {}),
                onFrame: frame => events.record(frame.type, frame.data as never, frame.context),
                onInvalid: () => events.record("test:process:fault", { kind: "protocol", error: invalidFrameError() }),
            })

            events.record("test:run:start", { files })

            let stdout = ""
            let stderr = ""
            let exitCode: number | null = 0
            let cancelled = options.signal?.aborted ?? false

            for (const file of files) {
                if (cancelled) break

                const fileStarted = performance.now()
                events.record("test:file:start", {}, { file })

                const outcome = await child.run(file, options.signal)
                stdout += outcome.stdout
                stderr += outcome.stderr
                cancelled = outcome.cancelled
                if (outcome.exitCode !== 0) exitCode = outcome.exitCode

                // A case that started and never reported a terminal result owes
                // the stream an answer: the process died holding it. Record the
                // failure the child could not, or the run reports fewer cases
                // than it actually attempted.
                for (const context of events.orphaned(file)) {
                    events.record("test:case:fail", {
                        durationMs: performance.now() - fileStarted,
                        error: err("UNKNOWN", {
                            detail: cancelled
                                ? "test process cancelled before producing a terminal result"
                                : "test process exited before producing a terminal result",
                        }),
                    }, context)
                }

                // A nonzero exit with no recorded failure means the process died
                // for a reason the test protocol never saw — a crash in a
                // preload, a native fault. Without this the run would report
                // "passed" on an exit code that says otherwise.
                if (outcome.exitCode !== 0 && !events.failed(file) && !cancelled) {
                    events.record("test:process:fault", {
                        kind: "exit",
                        error: err("UNKNOWN", { detail: `bun test exited with code ${outcome.exitCode}` }),
                    }, { file })
                }

                events.record("test:file:complete", {
                    exitCode: outcome.exitCode,
                    durationMs: performance.now() - fileStarted,
                }, { file })
            }

            const tally = events.tally()
            const status = cancelled ? "cancelled" : tally.failed > 0 || exitCode !== 0 ? "failed" : "passed"
            const durationMs = performance.now() - startedAt

            events.record("test:run:complete", { status, durationMs, ...tally })
            await events.settle()

            return {
                runId: runId,
                status: status,
                exitCode: exitCode,
                durationMs: durationMs,
                files: files,
                events: events.all,
                stdout: stdout,
                stderr: stderr,
            }
        },
    }
}

export type TestRunnerT = ReturnType<typeof TestRunner>
