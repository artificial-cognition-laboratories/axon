import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"

export type ProcessesOpts = {
    /** Where live pids are recorded, so a daemon that crashed can clean up after itself. */
    ledger: string
}

type Owned = { pid: number; label: string }

/**
 * Processes — every OS process the lab starts, and a record of them on disk.
 *
 * A world is a server, and each body is three processes (a display, a game
 * client, a frame capture). If the daemon dies without stopping them they
 * keep running, holding ports and displays the next start needs — so every
 * spawn is written down, and `reap()` kills whatever an earlier daemon left.
 */
export function Processes(opts: ProcessesOpts) {
    const owned = new Map<number, Owned>()

    function persist(): void {
        mkdirSync(dirname(opts.ledger), { recursive: true })
        writeFileSync(opts.ledger, JSON.stringify([...owned.values()], null, 2) + "\n")
    }

    return {
        /**
         * Start a process the lab owns. The child is recorded until it exits.
         * Set a variable to `undefined` in `env` to remove it from what the
         * child inherits.
         */
        spawn(input: {
            label: string
            cmd: string[]
            cwd?: string
            env?: Record<string, string | undefined>
            stdout?: "pipe" | string
            stdin?: "pipe"
        }) {
            const out = input.stdout === "pipe" ? "pipe" : input.stdout ? Bun.file(input.stdout) : "ignore"
            // An `undefined` in `input.env` REMOVES the variable, rather than
            // passing the string "undefined" or silently inheriting it.
            const env = Object.fromEntries(
                Object.entries({ ...process.env, ...input.env }).filter((entry): entry is [string, string] => entry[1] !== undefined),
            )
            // Its own process group (`setsid`), so stopping it reaches every
            // descendant. The game client is launched through a shell script,
            // and signalling only the script's pid leaves the dotnet process
            // under it running — a game nobody owns, holding a display.
            const proc = Bun.spawn(["setsid", ...input.cmd], {
                ...(input.cwd ? { cwd: input.cwd } : {}),
                env: env,
                stdout: out,
                stderr: out === "pipe" ? "pipe" : out,
                stdin: input.stdin ?? "ignore",
            })
            owned.set(proc.pid, { pid: proc.pid, label: input.label })
            persist()
            void proc.exited.then(() => {
                owned.delete(proc.pid)
                persist()
            })
            return {
                pid: proc.pid,
                exited: proc.exited,
                stdout: proc.stdout,
                stderr: proc.stderr,
                stdin: proc.stdin,
                /** Signal the whole group — the process and everything it started. */
                kill(signal: NodeJS.Signals = "SIGTERM"): void {
                    try {
                        process.kill(-proc.pid, signal)
                    } catch {
                        // The group is already gone.
                    }
                },
            }
        },

        /** Kill everything a previous daemon recorded and never cleaned up. */
        reap(): string[] {
            if (!existsSync(opts.ledger)) return []
            let recorded: Owned[]
            try {
                recorded = JSON.parse(readFileSync(opts.ledger, "utf-8")) as Owned[]
            } catch (cause) {
                throw new Error(`the lab's process ledger at ${opts.ledger} is unreadable`, { cause: cause })
            }
            const killed: string[] = []
            for (const entry of recorded) {
                if (owned.has(entry.pid)) continue
                try {
                    process.kill(-entry.pid, "SIGKILL")
                    killed.push(`${entry.label} (${entry.pid})`)
                } catch {
                    // Already gone — the ordinary case for a clean exit that
                    // raced the ledger write.
                }
            }
            persist()
            return killed
        },
    }
}

export type ProcessesT = ReturnType<typeof Processes>

/** Whether a process is alive. Signal 0 checks without touching it. */
export function alive(pid: number): boolean {
    try {
        process.kill(pid, 0)
        return true
    } catch {
        return false
    }
}
