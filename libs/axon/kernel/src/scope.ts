import type { AxonBlueprint, AxonScope, AxonScopeModule, AxonTool } from "@arcforge/types"

/**
 * scope — the ONE decision about what is in an agent's executable scope.
 *
 * The capsule is a separate OS process. Something is in scope only if that
 * process can actually load and call it, which means exactly one rule:
 *
 *   a tool is in scope when it has a real entry file (or inline source).
 *
 * Everything the model is told it can call, and everything an editor is
 * told exists, is derived from the AxonScope this produces. Two renderers
 * consume it — renderScope() for the model, scopeToDts() for TypeScript —
 * and they can differ only in SPELLING, never in membership, because
 * membership is settled here before either runs.
 *
 * That property is the point. Previously the capsule filtered for
 * loadability while the .d.ts generator rendered every scanned tool, so
 * the file claimed to describe the model's scope and described something
 * else entirely: an agent's npm dependencies, whose declarations had been
 * introspected and hoisted in as callable globals.
 *
 * An npm dependency is NOT a tool. It is available to the agent project's
 * SOURCE — importable by the author's own code — which is a bundler
 * concern. A tool is available to the AGENT, across a process boundary,
 * which is an execution concern. To turn a package into a tool, an author
 * re-exports it from src/tools/ deliberately.
 */

/** A tool the capsule can genuinely load — the only kind that may enter scope. */
export function isLoadable(tool: AxonTool): boolean {
    return Boolean(tool.entryPath) || tool.source !== undefined
}

/** One tool's contribution to the executable scope. */
export function toScopeModule(tool: AxonTool): AxonScopeModule {
    return {
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        members: tool.fns,
        ...(tool.flat ? { flat: true } : {}),
        ...(tool.ambientTypes ? { ambientTypes: tool.ambientTypes } : {}),
    }
}

/**
 * The blueprint's executable scope. Tools with no loadable entry are
 * excluded — declaring something the capsule cannot call would tell the
 * model to invoke a function that does not exist there.
 */
export function toScope(blueprint: AxonBlueprint): AxonScope {
    return { modules: blueprint.tools.filter(isLoadable).map(toScopeModule) }
}
