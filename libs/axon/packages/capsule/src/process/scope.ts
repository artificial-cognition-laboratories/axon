import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { capsuleFault } from "./fault"
import type { CapsuleCommand } from "../../types"
import type { ExecutionT } from "./execution"
import type { MediatorT } from "./mediator"
import type { SandboxWireT } from "./wire"

type ScopeOpts = {
    mediator: MediatorT
    wire: SandboxWireT
    /** Correlates each fn span to the command that made the call. */
    execution: ExecutionT
}

/** A tool module's shape once loaded: name + the functions it exports. */
type LoadedTool = {
    namespace: string
    flat: boolean
    values: Record<string, unknown>
}

/**
 * Writes bundled tool source to a real file and returns its path for
 * import() — a data: URI module specifier hits an OS-level max-length
 * ceiling well below what a real tool file (e.g. the full fs module) needs,
 * throwing NameTooLong. A real file has no such limit. Content-hashed
 * filename: repeated loads of the same source (reload, multiple sandboxes)
 * reuse the same file instead of leaking a new one per call.
 */
async function materializeSource(source: string): Promise<string> {
    const dir = join(tmpdir(), "axon-capsule-tools")
    await mkdir(dir, { recursive: true })
    const hash = createHash("sha256").update(source).digest("hex")
    const file = join(dir, `${hash}.ts`)
    await writeFile(file, source)
    return file
}

/**
 * Scope — the globals cmd:run code executes against. Loads each configured
 * CapsuleTool either under its namespace or as flat named exports, recursively
 * wrapping callable values so every call is mediated first. This is the actual
 * enforcement point; nothing in run() has a path to an unwrapped function.
 */
export function Scope(opts: ScopeOpts) {
    const { mediator, wire, execution } = opts
    const namespaces = new Map<string, LoadedTool>()

    function wrapValue(value: unknown, path: string, owner: string, receiver?: object): unknown {
        if (typeof value === "function") {
            return async (...args: unknown[]) => {
                const subject = typeof args[0] === "string" ? args[0] : ""
                const allowed = await mediator.check(path, subject, args, owner)
                if (!allowed) throw new Error(`CAPSULE_POLICY_DENIED: ${path} denied by policy`)

                // The tool-call span. Opened only AFTER policy admits the
                // call: a denied call is a policy fact (capsule:policy:denied),
                // not an execution that failed, and pairing a :start with no
                // matching end would leave a permanently-open bracket in
                // every flame graph.
                const commandId = execution.current?.id ?? ""
                const started = Date.now()
                wire.emit("capsule:fn:start", { commandId, module: owner, fn: path, args })
                try {
                    const result = await Reflect.apply(value, receiver, args)
                    wire.emit("capsule:fn:complete", { commandId, module: owner, fn: path, result, durationMs: Date.now() - started })
                    return result
                } catch (cause) {
                    wire.emit("capsule:fn:failed", {
                        commandId,
                        module: owner,
                        fn: path,
                        error: capsuleFault("CAPSULE_FN_FAILED", {
                            message: cause instanceof Error ? cause.message : String(cause),
                            context: { fn: path, module: owner },
                            cause,
                        }),
                        durationMs: Date.now() - started,
                    })
                    throw cause
                }
            }
        }

        if (value !== null && typeof value === "object") {
            return new Proxy(value, {
                get(target, key) {
                    const child = Reflect.get(target, key, target)
                    return typeof key === "string" ? wrapValue(child, `${path}.${key}`, owner, target) : child
                },
            })
        }

        return value
    }

    async function loadTool(tool: Extract<CapsuleCommand, { type: "tool:load" }>): Promise<void> {
        const started = Date.now()
        wire.emit("capsule:tool:load:start", { namespace: tool.namespace })
        try {
            const mod = "path" in tool
                ? await import(tool.path)
                : await import(await materializeSource(tool.source))

            const fallback = mod.default as { exports?: Record<string, unknown> } | undefined
            const named = Object.fromEntries(Object.entries(mod).filter(([name]) => name !== "default"))
            const exported = Object.keys(named).length > 0 ? named : (fallback?.exports ?? {})
            const values: Record<string, unknown> = {}
            for (const [name, value] of Object.entries(exported)) {
                const path = tool.flat ? name : `${tool.namespace}.${name}`
                values[name] = wrapValue(value, path, tool.namespace)
            }

            namespaces.set(tool.namespace, { namespace: tool.namespace, flat: tool.flat, values })
            wire.emit("capsule:tool:load:complete", { namespace: tool.namespace, fns: Object.keys(values), durationMs: Date.now() - started })
        } catch (cause) {
            wire.emit("capsule:tool:load:failed", {
                namespace: tool.namespace,
                error: capsuleFault("CAPSULE_TOOL_FAILED", {
                    message: cause instanceof Error ? cause.message : String(cause),
                    context: { namespace: tool.namespace },
                    cause,
                }),
                durationMs: Date.now() - started,
            })
        }
    }

    wire.onCommand((cmd: CapsuleCommand) => {
        if (cmd.type === "tool:load") {
            void loadTool(cmd)
        } else if (cmd.type === "tool:unload") {
            namespaces.delete(cmd.namespace)
            wire.emit("capsule:tool:unloaded", { namespace: cmd.namespace })
        }
    })

    return {
        /** Build the globals object cmd:run executes with, respecting flat placement. */
        globals(): Record<string, unknown> {
            const globals: Record<string, unknown> = {}
            for (const tool of namespaces.values()) {
                if (tool.flat) Object.assign(globals, tool.values)
                else globals[tool.namespace] = tool.values
            }
            return globals
        },
    }
}

export type ScopeT = ReturnType<typeof Scope>
