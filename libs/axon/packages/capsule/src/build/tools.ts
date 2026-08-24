import type { CapsuleCommand, CapsuleTool } from "../../types"
import type { CapsuleBusT } from "../../platform/bus"
import { err } from "@arcforge/err"

const TOOL_LOAD_TIMEOUT_MS = 30_000

type ToolsOpts = {
    send(cmd: CapsuleCommand): void
    bus: CapsuleBusT
    tools: CapsuleTool[]
    stderr(): string
}

/**
 * Load the configured tools into the subprocess scope.
 *
 * Sequential — one round-trip per tool. A failed or timed-out load fails
 * the build: a capsule missing scope the agent was promised is invalid
 * state, not a warning.
 */
export async function Tools(opts: ToolsOpts): Promise<void> {
    for (const tool of opts.tools) {
        await load(opts, tool)
    }
}

function load(opts: ToolsOpts, tool: CapsuleTool): Promise<void> {
    const { send, bus } = opts

    return new Promise<void>((resolve, reject) => {
        const offs: Array<() => void> = []

        function settle(fn: () => void) {
            clearTimeout(timer)
            for (const off of offs) off()
            fn()
        }

        const timer = setTimeout(() => {
            settle(() => reject(err("CAPSULE_TOOL_TIMEOUT", {
                detail: `"${tool.namespace}" not confirmed within ${TOOL_LOAD_TIMEOUT_MS}ms`,
                context: { namespace: tool.namespace, timeoutMs: TOOL_LOAD_TIMEOUT_MS },
            })))
        }, TOOL_LOAD_TIMEOUT_MS)

        offs.push(
            bus.on("capsule:tool:load:complete", e => {
                if (e.namespace !== tool.namespace) return
                const declared = tool.scope.members.map(member => member.name).sort()
                const loaded = [...e.fns].sort()
                if (declared.length !== loaded.length || declared.some((name, i) => name !== loaded[i])) {
                    settle(() => reject(err("CAPSULE_TOOL_SCOPE_MISMATCH", {
                        detail: `"${tool.namespace}" declares [${declared.join(", ")}] but exports [${loaded.join(", ")}]`,
                        context: { namespace: tool.namespace, declared, loaded },
                    })))
                    return
                }
                settle(resolve)
            }),
            bus.on("capsule:tool:load:failed", e => {
                if (e.namespace !== tool.namespace) return
                settle(() => reject(err("CAPSULE_TOOL_FAILED", {
                    detail: `"${e.namespace}" — ${e.error}`,
                    context: { namespace: e.namespace, cause: e.error },
                })))
            }),
            bus.on("capsule:exit", () => {
                const stderr = opts.stderr().trim()
                settle(() => reject(err("CAPSULE_TOOL_FAILED", {
                    detail: `subprocess exited while loading "${tool.namespace}"${stderr ? ` — ${stderr}` : ""}`,
                    context: { namespace: tool.namespace, ...(stderr ? { stderr } : {}) },
                })))
            }),
        )

        // Listeners armed — now ask.
        send(
            "source" in tool
                ? { type: "tool:load", namespace: tool.namespace, flat: tool.scope.flat === true, source: tool.source }
                : { type: "tool:load", namespace: tool.namespace, flat: tool.scope.flat === true, path: tool.path }
        )
    })
}
