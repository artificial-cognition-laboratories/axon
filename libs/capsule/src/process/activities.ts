import type { ActivityHandle, ActivityPayloads, ActivityType, AxonAmbient } from "@arcforge/types"
import type { ExecutionT } from "./execution"
import type { SandboxWireT } from "./wire"

type ActivitiesOpts = {
    wire: SandboxWireT
    execution: ExecutionT
}

/**
 * Activities — the sandbox side of the semantic activity channel. Owns the
 * ambient axon.activity() verb: emits a "declared" event the moment a tool
 * calls it (the row appears live, mid-script), pairs the returned handle's
 * done() with the same activity id, and correlates everything to the running
 * command through the Execution async context — same pattern as Console.
 *
 * Auto-settle carries the phases tool authors would otherwise forget:
 * Runner calls settle(commandId) when a command ends, closing anything
 * still open — done on a clean exit, failed (with the command's error)
 * when the script threw. A tool that only writes the one declare line
 * still produces a correct start→settle pair.
 *
 * Write-only telemetry: nothing here returns data to sandboxed code or
 * reaches back into the host. A lying emission can only mislabel its own
 * UI row.
 */
export function Activities(opts: ActivitiesOpts) {
    const { wire, execution } = opts
    /** Open (declared, unsettled) activities per command — settle fns keyed by activity id. */
    const open = new Map<string, Map<string, (error?: string) => void>>()

    function activity<T extends ActivityType>(type: T, data: Partial<ActivityPayloads[T]> = {}): ActivityHandle<T> {
        const commandId = execution.current?.id ?? null
        const id = crypto.randomUUID()
        let settled = false

        wire.emit("capsule:activity", { commandId, id, activity: type, phase: "declared", data })

        function settleWith(phase: "done" | "failed", settleData: Partial<ActivityPayloads[T]>, error?: string): void {
            if (settled) return
            settled = true
            if (commandId) open.get(commandId)?.delete(id)
            wire.emit("capsule:activity", { commandId, id, activity: type, phase, data: settleData, ...(error !== undefined ? { error } : {}) })
        }

        if (commandId) {
            let perCommand = open.get(commandId)
            if (!perCommand) {
                perCommand = new Map()
                open.set(commandId, perCommand)
            }
            perCommand.set(id, error => settleWith(error === undefined ? "done" : "failed", {}, error))
        }

        return {
            done(settleData: Partial<ActivityPayloads[T]> = {}): void {
                settleWith("done", settleData)
            },
        }
    }

    return {
        activity,
        /** Compatibility projection; Sandbox composes activity into the full capsule Axon facade. */
        ambient: { activity } satisfies AxonAmbient,

        /**
         * Close every activity the command left open — done on a clean end,
         * failed (carrying the command's error) when the script threw. Call
         * BEFORE emitting the cmd:complete/failed event so the wire order
         * reads: activities settle, then the command settles.
         */
        settle(commandId: string, error?: string): void {
            const perCommand = open.get(commandId)
            if (!perCommand) return
            open.delete(commandId)
            for (const settleFn of perCommand.values()) settleFn(error)
        },
    }
}

export type ActivitiesT = ReturnType<typeof Activities>
