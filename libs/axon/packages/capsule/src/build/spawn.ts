import { spawn as nodeSpawn, type ChildProcess } from "node:child_process"
import { err } from "@arcforge/err"
import type { CapsuleBlueprint } from "../../types"
import { ENTRYPOINT } from "../../platform/confine"

export type SpawnedChild = {
    proc: ChildProcess
    pid: number
    kill(): void
    /** Detach the host-exit kill hook. */
    dispose(): void
}

type SpawnOpts = {
    config: CapsuleBlueprint
    /** From userspace enforcement — wins over config.spawn and the default. */
    spawnCommand?: { command: string; args: string[] }
}

/**
 * Spawn — resolve the command and start the subprocess.
 *
 * Command precedence: userspace runner → config.spawn override → bun default.
 * The child inherits the host env by default — same trust boundary as the
 * process spawning it; the sandboxing boundary is the OS-level axon-runner
 * (setuid, separate user), not env isolation. config.env overlays on top,
 * so a blueprint can still narrow or strip vars explicitly when it needs to.
 */
export function Spawn(opts: SpawnOpts): SpawnedChild {
    const { config } = opts

    let command: string
    let args: string[]

    if (opts.spawnCommand) {
        ({ command, args } = opts.spawnCommand)
    } else if (config.spawn) {
        ({ command, args } = config.spawn)
    } else {
        command = "bun"
        args = ["run", ENTRYPOINT]
    }

    const proc = nodeSpawn(command, args, {
        cwd: config.cwd,
        env: {
            ...process.env,
            ...config.env,
            AXON_CAPSULE_POLICY: JSON.stringify(config.policy),
        },
        stdio: ["pipe", "pipe", "pipe"],
    })

    // Detach from the host event loop — without this the host cannot exit
    // until the subprocess does, leaving zombies when the host crashes.
    proc.unref()

    function kill() {
        try {
            if (process.platform === "win32") proc.kill()
            else proc.kill("SIGKILL")
        } catch (err) {
            // The subprocess being already gone is fine; anything else is not.
            const msg = err instanceof Error ? err.message : String(err)
            if (!msg.includes("ESRCH") && !msg.includes("process not found") && !msg.includes("No such process")) {
                throw err
            }
        }
    }

    // The subprocess must never outlive the host. Synchronous exit handlers
    // are the only reliable cross-platform guarantee.
    process.on("exit", kill)

    if (proc.pid === undefined) {
        process.removeListener("exit", kill)
        throw err("CAPSULE_SPAWN_FAILED", { context: { command, args } })
    }

    return {
        proc,
        pid: proc.pid,
        kill,
        dispose() {
            process.removeListener("exit", kill)
        },
    }
}
