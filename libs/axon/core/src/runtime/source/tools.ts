import { err } from "@arcforge/err"
import type { AxonBlueprint } from "@arcforge/types"
import type { AxonKernelT } from "@arcforge/kernel"

type ToolsOpts = {
    blueprint: AxonBlueprint
    kernel: AxonKernelT
}

/**
 * axon.tools.<namespace>.<fn>(...) — every call is a fake capsule request.
 * There is no per-function RPC into the capsule; the only conversation it
 * has is run(code). So a tool call from script-land is synthesized as the
 * same kind of code an agent-generated <typescript> block sends — routed
 * through kernel.run(), mediated by the same policy, nothing bypassed.
 *
 * Shaped from blueprint.tools (declared namespaces/fns), not a live
 * introspection of the capsule — the capsule is the only source of truth
 * for whether the namespace is actually loaded; an unloaded namespace fails
 * loudly at call time (the underlying run() throws "not defined"), same as
 * agent code calling a namespace with no tool loaded.
 */
export function Tools(opts: ToolsOpts) {
    const tools: Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>> = {}

    for (const tool of opts.blueprint.tools) {
        const namespace: Record<string, (...args: unknown[]) => Promise<unknown>> = {}

        for (const fn of tool.fns) {
            namespace[fn.name] = (...args: unknown[]) => callTool(opts.kernel, tool.name, fn.name, tool.flat === true, args)
        }

        tools[tool.name] = namespace
    }

    return tools
}

async function callTool(kernel: AxonKernelT, namespace: string, fnName: string, flat: boolean, args: unknown[]): Promise<unknown> {
    // args serialized once, embedded as a JSON literal — never string-interpolated
    // into the call itself, so an argument value can never break out of its slot.
    // Bare trailing expression, not `return` — the capsule captures REPL
    // completion values exactly as it does for an agent-authored block.
    const argsLiteral = JSON.stringify(JSON.stringify(args))
    const target = flat ? fnName : `${namespace}.${fnName}`
    const code = `${target}(...JSON.parse(${argsLiteral}))`

    // A script calling axon.tools.foo.bar() expects a normal call contract —
    // resolve with the value, throw on failure — unlike kernel.run()'s own
    // stable-result shape, which exists so the COGNET can discriminate
    // outcomes without a try/catch. This is the one place that unwraps back
    // into "throws like any other function call" for script-land.
    const result = await kernel.run(code)
    if (result.ok) return result.value
    throw err("TOOL_CALL_FAILED", {
        detail: `${target} failed: ${result.error?.message ?? "unknown error"}`,
        context: { namespace, fnName, kind: result.error?.kind },
    })
}
