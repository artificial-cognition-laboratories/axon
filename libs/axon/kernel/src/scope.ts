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
 *
 * Flat members are then deduped by CALLABLE NAME, which is a different
 * question from the one merge() answers. merge() resolves collisions between
 * TOOL names (the filename): an agent's `weather.ts` shadowing a module's
 * `weather.ts`. It cannot see two differently-named files whose exports
 * collide — an agent's `weather.ts` and a module's `forecast.ts` both
 * exporting `now()` are two distinct tools by its reckoning, so both survive.
 *
 * Both then install flat, and everything downstream silently picks a winner:
 * the .d.ts and the model's <scope> each declare `function now()` twice, and
 * the capsule builds its globals with Object.assign, so whichever tool loads
 * last wins and the other export is unreachable with nothing reported. The
 * agent always wins here, matching merge()'s precedence, and the loser is
 * dropped from the scope rather than rendered as a duplicate declaration.
 */
export function toScope(blueprint: AxonBlueprint): AxonScope {
    const loadable = blueprint.tools.filter(isLoadable)
    const claimed = new Set<string>()
    const modules: AxonScopeModule[] = []

    // Agent-origin tools first so they claim contested names, regardless of the
    // order modules happen to appear in the blueprint.
    for (const tool of [...loadable].sort((a, b) => rank(a) - rank(b))) {
        const module = toScopeModule(tool)
        if (!module.flat) {
            modules.push(module)
            continue
        }

        const members = module.members.filter(member => !claimed.has(member.name))
        for (const member of members) claimed.add(member.name)
        if (members.length > 0) modules.push({ ...module, members })
    }

    // Restore blueprint order: the filtering above needs agent-first, but the
    // rendered scope should read in the order the blueprint declares.
    return { modules: modules.sort((a, b) => order(loadable, a) - order(loadable, b)) }
}

/** Agent-authored tools outrank module tools when both claim a callable name. */
function rank(tool: AxonTool): number {
    return tool.origin === "module" ? 1 : 0
}

function order(tools: AxonTool[], module: AxonScopeModule): number {
    return tools.findIndex(tool => tool.name === module.name)
}
