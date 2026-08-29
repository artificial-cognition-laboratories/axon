import { mkdir, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import type { UpdateRecord } from "../store/types"
import type { UpdateRequest } from "./contract"
import { withPropagationRetry } from "../../build/project/propagation"

/** How the installer reaches the outside world. Injected so tests drive it without spawning. */
export type InstallerIo = {
    run?: (command: string[]) => Promise<{ code: number; stdout: string }>
    sleep?: (milliseconds: number) => Promise<void>
    out?: (message: string) => void
    err?: (message: string) => void
}

/**
 * Installer — replace the globally installed Axon with a named version.
 *
 * Runs in the update-helper process, AFTER the app has exited: a package
 * manager cannot replace the binary of a running program, which is the whole
 * reason this is a separate process rather than a method on Updates().
 *
 * Every outcome is recorded to the state file before returning, because the
 * next app launch reads that file to tell the user what happened while it was
 * gone. Failure rolls back to the previous version and says so — an update that
 * half-applied and left nothing runnable is the one outcome worth real effort
 * to avoid.
 */
export function Installer(io: InstallerIo = {}) {
    const run = io.run ?? runCommand
    const sleep = io.sleep ?? Bun.sleep
    const out = io.out ?? (message => process.stdout.write(message))
    const report = io.err ?? (message => process.stderr.write(message))

    /** Write the state file atomically — the next launch reads it to explain itself. */
    async function record(path: string, value: UpdateRecord): Promise<void> {
        await mkdir(dirname(path), { recursive: true })
        const temporary = `${path}.${process.pid}.tmp`
        await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", "utf-8")
        await rename(temporary, path)
    }

    /**
     * Install the target, retrying while the version is still propagating.
     *
     * The policy lives in project/propagation.ts, shared with the dependency
     * installer — this path had it right and that one did not, so `axon update`
     * succeeded and the next `axon init` failed against the same registry
     * seconds later.
     *
     * `--no-cache` bypasses Bun's manifest cache; the BACKOFF is what actually
     * waits for the edge to catch up. Both are needed and only together.
     */
    async function install(request: UpdateRequest): Promise<boolean> {
        const outcome = await withPropagationRetry(
            async () => {
                const result = await run([request.bun, "add", "-g", "--no-cache", `@arcforge/axon@${request.to}`])
                // No `output`: bun's stderr is inherited so the user sees the
                // install directly, which means the text to classify on never
                // reaches here. Retries unconditionally — see PropagationAttempt.
                return { ok: result.code === 0 }
            },
            {
                sleep,
                onRetry: delay => report(
                    `Axon ${request.to} is not available from this npm edge yet; retrying in ${delay / 1_000}s…\n`,
                ),
            },
        )
        return outcome.ok
    }

    /** The installed binary must report the version we asked for — anything else is a failed install. */
    async function verify(request: UpdateRequest): Promise<boolean> {
        const result = await run([request.axon, "--version"])
        return result.code === 0 && result.stdout.trim() === request.to
    }

    async function rollback(request: UpdateRequest): Promise<boolean> {
        report("Axon update failed verification; restoring the previous version…\n")
        const result = await run([request.bun, "add", "-g", `@arcforge/axon@${request.from}`])
        return result.code === 0
    }

    return {
        /** Apply the update. Returns the process exit code: 0 installed, 1 rolled back or failed. */
        async apply(request: UpdateRequest): Promise<number> {
            await record(request.state, {
                status: "running",
                from: request.from,
                to: request.to,
                updatedAt: new Date().toISOString(),
            })
            out(`\nUpdating Axon ${request.from} → ${request.to}…\n`)

            if (await install(request) && await verify(request)) {
                await record(request.state, {
                    status: "complete",
                    from: request.from,
                    to: request.to,
                    updatedAt: new Date().toISOString(),
                })
                out(`✓ Axon ${request.to} installed. Run axon to continue.\n\n`)
                return 0
            }

            const restored = await rollback(request)
            const error = restored
                ? `update to ${request.to} failed verification; restored ${request.from}`
                : `update to ${request.to} failed and rollback to ${request.from} also failed`

            await record(request.state, {
                status: restored ? "rolled-back" : "failed",
                from: request.from,
                to: request.to,
                updatedAt: new Date().toISOString(),
                error: error,
            })

            const recovery = process.platform === "win32"
                ? "irm https://axon.arclabs.it/install.ps1 | iex"
                : "curl -fsSL https://axon.arclabs.it/install | bash"
            report(`${error}. Run ${recovery} to recover.\n\n`)
            return 1
        },
    }
}

export type InstallerT = ReturnType<typeof Installer>

async function runCommand(command: string[]): Promise<{ code: number; stdout: string }> {
    const proc = Bun.spawn(command, {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "inherit",
        env: process.env,
    })
    const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()])
    return { code: code, stdout: stdout }
}
