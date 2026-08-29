import type { AxonTool } from "@arcforge/types"
import { isLoadable, scopeMemberCount, scopeToDts, toScopeModule } from "@arcforge/core"
import { writeDts, type TypegenKind } from "./write"

/**
 * .agent/tool-globals.d.ts — the agent's executable scope as ambient
 * TypeScript, so tool calls in the author's own src/tools, src/scripts,
 * hooks, and routes typecheck against exactly what the capsule provides.
 *
 * This file does not decide anything. Membership comes from isLoadable()
 * and the rendering from scopeToDts(), both in @arcforge/core — the same pair
 * that produces the <scope> block the model receives. The two surfaces
 * are one list by construction, not by convention.
 *
 * That matters because this file used to build its own list, and drifted:
 * it rendered every scanned tool including the agent's npm dependencies,
 * whose .d.ts exports had been introspected and hoisted in as callable
 * globals. The capsule filtered them out, so the file described a scope
 * the model never had. An npm dependency is importable by the agent's
 * source; it is not a tool. To make one a tool, re-export it from
 * src/tools/.
 */
export function generateToolGlobals(root: string, tools: AxonTool[], kind: TypegenKind = "agent"): number {
    const scope = { modules: tools.filter(isLoadable).map(toScopeModule) }

    const count = scopeMemberCount(scope)
    if (count === 0) return 0

    writeDts(root, "tool-globals.d.ts", scopeToDts(scope), kind)
    return count
}
