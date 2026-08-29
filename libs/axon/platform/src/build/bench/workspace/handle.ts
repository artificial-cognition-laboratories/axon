import { join } from "node:path"
import type { BenchWorkspaceChange } from "@arcforge/types"
import { snapshotWorkspace, workspaceChanges, type WorkspaceSnapshot } from "./files"

/**
 * What a scenario can ask about the world after the agent has acted.
 *
 * Every coding benchmark needs the same three questions — did the suite pass,
 * what changed, what does the patch look like — and two of them are
 * unanswerable from inside the test. `changed()` and `diff()` need the world
 * as it was BEFORE the agent booted, and by the time a test runs that state
 * only exists in the harness's baseline snapshot.
 *
 * `toString()` returns the path, so the handle can still be passed anywhere a
 * directory is expected without callers reaching for a property.
 */
export type WorkspaceHandle = {
    readonly path: string
    toString(): string

    /** Read a file relative to the workspace root. */
    read(relativePath: string): Promise<string>
    exists(relativePath: string): Promise<boolean>

    /** Paths the agent added, modified, or removed, relative to the root. */
    changed(): Promise<string[]>
    /** The same set with detail: kind, sizes, hashes. */
    changes(): Promise<BenchWorkspaceChange[]>
    /** Unified diff of everything that changed. */
    diff(): Promise<string>

    tests: {
        /** Run the workspace's own suite. True when it exits clean. */
        pass(opts?: { timeoutMs?: number }): Promise<boolean>
        /** The suite's combined output — worth attaching when a trial scores badly. */
        output(opts?: { timeoutMs?: number }): Promise<{ ok: boolean; text: string }>
    }
}

export type WorkspaceHandleOpts = {
    path: string
    before: WorkspaceSnapshot
    ignore: string[]
    /** Command that runs the workspace's suite. Defaults to `bun test`. */
    testCommand?: string[]
}

/** How long the workspace's own suite may run before it is treated as failing. */
const DEFAULT_TEST_TIMEOUT_MS = 120_000

export function WorkspaceHandle(opts: WorkspaceHandleOpts): WorkspaceHandle {
    async function after(): Promise<WorkspaceSnapshot> {
        return (await snapshotWorkspace(opts.path, { ignore: opts.ignore })).files
    }

    async function changes(): Promise<BenchWorkspaceChange[]> {
        return workspaceChanges(opts.before, await after())
    }

    async function runTests(timeoutMs: number): Promise<{ ok: boolean; text: string }> {
        const command = opts.testCommand ?? ["bun", "test"]
        const proc = Bun.spawn(command, {
            cwd: opts.path,
            stdout: "pipe",
            stderr: "pipe",
            // The suite belongs to the task, not to this process. Without its
            // own group a runaway test tree survives the timeout below and
            // holds the whole benchmark open.
            detached: true,
        })

        const timeout = Bun.sleep(timeoutMs).then(() => "timeout" as const)
        const finished = Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
        ])

        const outcome = await Promise.race([finished, timeout])
        if (outcome === "timeout") {
            try {
                process.kill(-proc.pid, "SIGKILL")
            } catch {
                proc.kill()
            }
            return { ok: false, text: `workspace test suite exceeded ${timeoutMs}ms and was killed` }
        }

        const [stdout, stderr, code] = outcome
        return { ok: code === 0, text: `${stdout}${stderr}` }
    }

    return {
        get path() {
            return opts.path
        },
        toString() {
            return opts.path
        },

        async read(relativePath) {
            return Bun.file(join(opts.path, relativePath)).text()
        },
        async exists(relativePath) {
            return Bun.file(join(opts.path, relativePath)).exists()
        },

        async changed() {
            return (await changes()).map(change => change.path)
        },
        changes,

        async diff() {
            // `git diff --no-index` against the baseline is not available — the
            // baseline is a hash snapshot, not a tree on disk. Rendering from
            // the change records keeps the output honest about what is known:
            // which paths moved and how, without inventing line-level detail
            // the snapshot never captured.
            const entries = await changes()
            if (entries.length === 0) return ""
            return entries.map(change => `${change.kind}\t${change.path}`).join("\n")
        },

        tests: {
            async pass(options = {}) {
                return (await runTests(options.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS)).ok
            },
            async output(options = {}) {
                return runTests(options.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS)
            },
        },
    }
}
