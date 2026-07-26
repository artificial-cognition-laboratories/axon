import type { CapsulePolicy, CapsuleTool } from "../../types"
import { Console } from "./console"
import { Mediator } from "./mediator"
import { Runner } from "./runner"
import { Scope } from "./scope"
import { SandboxProcs } from "./procs"
import { SandboxWire } from "./wire"
import { installScope, realExit } from "../scope/scope"
import { Execution } from "./execution"
import { Activities } from "./activities"
import { Host } from "./host"

type SandboxOpts = {
    policy: CapsulePolicy
}

/**
 * Sandbox — the subprocess entrypoint's orchestrator. Pure composition: wires
 * wire → mediator → scope → procs → runner, boots, and reports readiness.
 * Mirrors Capsule() on the host side — this is the other half of the same
 * protocol, wired the same way. Also installs process.run/process.spawn —
 * SandboxProcs' own methods, exposed as globals so sandboxed code can shell
 * out directly without a wire round trip.
 */
export function Sandbox(opts: SandboxOpts) {
    const wire = SandboxWire()
    const sandboxConsole = Console({ wire })
    const mediator = Mediator({ policy: opts.policy, wire })
    const scope = Scope({ mediator, wire })
    const procs = SandboxProcs({ mediator, wire })
    const execution = Execution()
    const activities = Activities({ wire, execution })
    const host = Host({ wire, execution })
    Runner({ scope, wire, console: sandboxConsole, execution, activities })

    installScope({
        run: (command, runOpts) => procs.run(command, runOpts, execution.current?.signal),
        spawn: (command, spawnOpts) => procs.spawn(command, spawnOpts),
        write: (level, data) => sandboxConsole.write(level, data),
        axon: {
            ...host.ambient,
            activity: activities.activity,
        },
    })

    wire.onCommand(cmd => {
        if (cmd.type === "policy:update") mediator.update(cmd.policy)
        if (cmd.type === "shutdown") {
            host.rejectAll(new Error("capsule shutting down"))
            procs.killAll()
            realExit(0)
        }
    })

    return {
        ready(): void {
            wire.emit("capsule:boot:complete", { durationMs: process.uptime() * 1000 })
        },
    }
}

export type SandboxT = ReturnType<typeof Sandbox>
