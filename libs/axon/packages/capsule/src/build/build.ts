import type { CapsuleCommand, CapsuleBlueprint } from "../../types"
import type { CapsuleBusT } from "../../platform/bus"
import { handshake } from "../../platform/handshake"
import { Confinement } from "../../platform/confine"
import { Spawn } from "./spawn"
import { Tools } from "./tools"
import { Wire } from "./wire"

/**
 * One subprocess incarnation, fully wired. Deliberately dumb — no behavior,
 * no state beyond the pipe. The supervisor decides when one lives or dies.
 */
export type CapsuleRuntime = {
    pid: number
    send(cmd: CapsuleCommand): void
    kill(): void
    /** Reverse-order teardown: listeners, ACLs. Idempotent. */
    cleanup(): Promise<void>
}

type BuildOpts = {
    config: CapsuleBlueprint
    bus: CapsuleBusT
}

/**
 * Build — CapsuleBlueprint in, live incarnation out. Atomic: every step
 * registers its undo; a failure at step N unwinds N-1..1 and rethrows.
 * No half-built capsule is ever observable.
 *
 * Same path for first boot and every crash-restart.
 *
 * Pipeline: confine → spawn → wire → handshake → tools
 */
export async function Build(opts: BuildOpts): Promise<CapsuleRuntime> {
    const { config, bus } = opts
    const undo: Array<() => Promise<void> | void> = []
    let unwound = false

    async function unwind(): Promise<void> {
        if (unwound) return
        unwound = true
        for (const step of [...undo].reverse()) {
            await step()
        }
    }

    try {
        // 1. Confine — the OS box. isolation "auto"/"hardened" on Linux builds it
        //    (fail loud if the tier's primitives are missing); "none" is the
        //    explicit opt-out; non-Linux has no OS wall. Both skips fall back to
        //    current-user spawn with mediator-only enforcement.
        const tier = config.policy.isolation
        const confined = tier && tier !== "none" && process.platform === "linux"
            ? await Confinement({ tier, cwd: config.cwd, policy: config.policy }).build()
            : null
        if (confined) undo.push(confined.cleanup)

        // 2. Spawn — resolve command precedence, explicit env + policy carrier.
        const child = Spawn({ config, ...(confined ? { spawnCommand: confined.spawnCommand } : {}) })
        undo.push(() => {
            child.kill()
            child.dispose()
        })

        // 3. Wire — stdio ↔ bus bridge for this incarnation.
        const wire = Wire({ child, bus })
        undo.push(wire.detach)

        // 4. Handshake — the subprocess dispatcher is up.
        await handshake({
            bus,
            timeoutMs: config.boot?.timeoutMs ?? 10_000,
            stderr: wire.stderr,
        })

        // 5. Tools — the promised scope is loaded. Failure fails the build.
        await Tools({ send: wire.send, bus, tools: config.tools, stderr: wire.stderr })

        return {
            pid: child.pid,
            send: wire.send,
            kill: child.kill,
            cleanup: unwind,
        }
    } catch (cause) {
        await unwind()
        throw cause
    }
}
