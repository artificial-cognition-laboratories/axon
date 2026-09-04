import type { ProcNode } from "./tree"

/**
 * The live process forest — agents, the subagents they spawned, and the
 * processes each of those is running, as one tree.
 *
 * ── Why this is shared ──────────────────────────────────────────────────────
 *
 * A subagent is spawned by shelling out to `axon run --parent <sessionId>`, so
 * one spawn produces two rows at two layers: a proc on the parent's log (the
 * `axon` command itself) and an independent agent instance carrying
 * `parentSessionId`. Joining those two structures back into one tree is the
 * same problem for every surface that draws it — the TUI's `/` palette and the
 * Fleet extension's Instances view — and the ordering rules below are subtle
 * enough that a second implementation would drift rather than merely differ.
 *
 * ── Why it is generic ───────────────────────────────────────────────────────
 *
 * Surfaces disagree about what an agent IS. The TUI's InstanceView carries
 * focus and tombstones; the extension's AxonInstance carries a pid and a
 * project root. Neither is wrong, and widening one to cover both would put
 * `focused` on a record that cannot be focused. The forest needs exactly three
 * facts from an agent — its id, its parent, and its procs — so it asks for
 * those and stays ignorant of the rest.
 *
 * ── Why the forest, not the flattened list ──────────────────────────────────
 *
 * A terminal draws an indented list; VS Code's TreeDataProvider asks for one
 * node's children at a time and owns expansion itself. Sharing the flattened
 * list would force the extension to flatten and then re-derive parentage from
 * indent, which is the same information twice with a chance to disagree.
 * `forest()` returns the structure; `flatten()` is for surfaces that draw
 * indentation themselves.
 */

/** The three facts the forest needs from an agent. Anything else is the surface's business. */
export type ForestAgent = {
    sessionId: string
    /** Null or absent for a user-owned root; a spawning agent's id otherwise. */
    parentSessionId?: string | null
    /** What this agent has spawned, as `procTree()` folded it from its own log. */
    processes?: readonly ProcNode[]
}

/**
 * One agent and everything hanging under it.
 *
 * `subagents` and `procs` stay separate rather than being concatenated into
 * one `children` array: they are different kinds of thing with different
 * affordances (a conversation can be focused, a `sleep 3600` cannot), and a
 * surface that had to re-split them would be discriminating on a union we
 * already knew the answer to. Rendering order across the two is fixed —
 * subagents first, see `childrenOf` — so the split costs nothing.
 */
export type ForestNode<Agent extends ForestAgent> = {
    agent: Agent
    /** Instances this one spawned, each with its own subtree. */
    subagents: ForestNode<Agent>[]
    /** Processes this agent spawned directly, in spawn order. */
    procs: readonly ProcNode[]
}

/**
 * Build the forest from a flat list of live agents.
 *
 * Roots are returned in the order given, except as reordered by `pinned` —
 * a list navigated with a cursor must not reorder under the hand mid-preview,
 * so a surface that previews captures an order once and passes it here.
 *
 * Only ROOTS are pinned. A child always sits under its parent, so pinning a
 * focused subagent to the top would have to tear it out of the tree it belongs
 * to; its root rises instead, which brings it along and keeps the shape.
 */
export function forest<Agent extends ForestAgent>(
    agents: readonly Agent[],
    opts?: {
        /** Session ids in preferred root order. Ids not listed keep list order, after those that are. */
        pinned?: readonly string[]
    },
): ForestNode<Agent>[] {
    const byId = new Map(agents.map(agent => [agent.sessionId, agent]))

    const childrenOf = new Map<string, Agent[]>()
    const roots: Agent[] = []
    for (const agent of agents) {
        // A parent that is gone (exited and pruned) makes this a root: it has
        // to render somewhere, and hanging it off a row that does not exist is
        // the one option that cannot work.
        const parentId = agent.parentSessionId
        const parent = parentId ? byId.get(parentId) : undefined
        if (!parent) {
            roots.push(agent)
            continue
        }
        const siblings = childrenOf.get(parent.sessionId)
        if (siblings) siblings.push(agent)
        else childrenOf.set(parent.sessionId, [agent])
    }

    const order = new Map((opts?.pinned ?? []).map((id, index) => [id, index]))
    const rank = (agent: Agent): number => order.get(agent.sessionId) ?? Number.MAX_SAFE_INTEGER
    roots.sort((left, right) => rank(left) - rank(right))

    // Cycle guard. Parentage is stamped at spawn and never rewritten, so a
    // cycle should be impossible — but if one existed, every agent in it would
    // have a visible parent, none would become a root, and they would vanish
    // from the view while still running. An unreachable running agent is
    // strictly worse than an oddly-drawn one.
    const seen = new Set<string>()
    const build = (agent: Agent): ForestNode<Agent> | null => {
        if (seen.has(agent.sessionId)) return null
        seen.add(agent.sessionId)
        return {
            agent,
            subagents: (childrenOf.get(agent.sessionId) ?? [])
                .map(build)
                .filter((node): node is ForestNode<Agent> => node !== null),
            procs: agent.processes ?? [],
        }
    }

    const built = roots.map(build).filter((node): node is ForestNode<Agent> => node !== null)

    // Anything the walk never reached — only possible inside a cycle — renders
    // flat at the root rather than not at all.
    for (const agent of agents) {
        if (seen.has(agent.sessionId)) continue
        seen.add(agent.sessionId)
        built.push({ agent, subagents: [], procs: agent.processes ?? [] })
    }
    return built
}

/**
 * A node's children in render order: subagents, then its own processes.
 *
 * A conversation is a bigger thing than a shell command, and a burst of
 * short-lived `run` rows must not push a subagent off the visible window.
 *
 * This is the one place the two child kinds are interleaved, so a surface that
 * asks for children lazily (VS Code) and one that flattens (a terminal) cannot
 * disagree about the order.
 */
export function childrenOf<Agent extends ForestAgent>(
    node: ForestNode<Agent>,
): ({ kind: "agent"; node: ForestNode<Agent> } | { kind: "proc"; proc: ProcNode })[] {
    return [
        ...node.subagents.map(child => ({ kind: "agent" as const, node: child })),
        ...node.procs.map(proc => ({ kind: "proc" as const, proc })),
    ]
}

/** Where a row sits in the drawn tree — for surfaces that render indentation themselves. */
export type Indented = { indent: number; last: boolean }

/**
 * Flatten the forest into display order, stamping indent and last-child.
 *
 * `indent` is computed HERE rather than read off the record. An agent's
 * `depth` is its true depth in the runtime forest, which is not the same as
 * its indent: a subagent whose parent has already exited and been pruned would
 * render indented under nothing. Deriving it from the rendered ancestry keeps
 * the drawing honest about what is actually on screen.
 */
export function flatten<Agent extends ForestAgent>(
    nodes: readonly ForestNode<Agent>[],
): ({ kind: "agent"; agent: Agent } & Indented | { kind: "proc"; proc: ProcNode; ownerSessionId: string } & Indented)[] {
    const rows: ReturnType<typeof flatten<Agent>> = []

    const walk = (node: ForestNode<Agent>, indent: number, last: boolean): void => {
        rows.push({ kind: "agent", agent: node.agent, indent, last })
        const children = childrenOf(node)
        children.forEach((child, index) => {
            const isLast = index === children.length - 1
            if (child.kind === "agent") walk(child.node, indent + 1, isLast)
            else rows.push({
                kind: "proc",
                proc: child.proc,
                ownerSessionId: node.agent.sessionId,
                indent: indent + 1,
                last: isLast,
            })
        })
    }
    nodes.forEach((node, index) => walk(node, 0, index === nodes.length - 1))
    return rows
}
