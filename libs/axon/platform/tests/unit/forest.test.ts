import { describe, it, expect } from "bun:test"
import { forest, childrenOf, flatten, type ProcNode } from "../../src"

/**
 * The live instance forest — agents, their subagents, and each one's procs.
 *
 * Two surfaces render this: the TUI's `/` palette (flattened, indented) and
 * the Fleet extension's Instances view (lazy, one node's children at a time).
 * The ordering rules are what silently regresses, and a divergence between the
 * two surfaces would be invisible until someone had both open — so they are
 * pinned here, once, on the shared implementation.
 *
 * The TUI's own test file covers the same rules through its projection; this
 * one covers the structure directly, including the lazy `childrenOf` path the
 * extension takes, which flattening never exercises.
 */

type Agent = { sessionId: string; parentSessionId?: string | null; processes?: ProcNode[] }

function agent(sessionId: string, parentSessionId: string | null, processes: ProcNode[] = []): Agent {
    return { sessionId, parentSessionId, processes }
}

function proc(command: string, over: Partial<ProcNode> = {}): ProcNode {
    return {
        procId: command,
        kind: "managed",
        command,
        status: "running",
        startedAt: 0,
        output: [],
        ...over,
    }
}

/** Every row in display order — agents by sessionId, procs by command. */
const labels = (rows: ReturnType<typeof flatten<Agent>>): string[] =>
    rows.map(row => row.kind === "agent" ? row.agent.sessionId : row.proc.command)

describe("forest", () => {
    it("hangs a subagent under its parent", () => {
        const roots = forest([agent("a", null), agent("b", null), agent("a1", "a")])

        expect(roots.map(root => root.agent.sessionId)).toEqual(["a", "b"])
        expect(roots[0]!.subagents.map(node => node.agent.sessionId)).toEqual(["a1"])
    })

    it("nests recursively rather than flattening at one level", () => {
        // The rule the extension's old tree broke: it mapped children to nodes
        // with an empty child list, so a subagent's own subagent vanished.
        const roots = forest([agent("a", null), agent("a1", "a"), agent("a1x", "a1")])

        expect(roots[0]!.subagents[0]!.subagents[0]!.agent.sessionId).toBe("a1x")
    })

    it("promotes an orphan to a root", () => {
        // The parent exited and its record was pruned. The child has to render
        // somewhere, and hanging it off a row that is not on screen is the one
        // option that cannot work.
        const roots = forest([agent("orphan", "gone")])

        expect(roots.map(root => root.agent.sessionId)).toEqual(["orphan"])
    })

    it("orders roots by the pinned order, leaving the rest in list order", () => {
        const roots = forest([agent("a", null), agent("b", null), agent("c", null)], { pinned: ["c"] })

        expect(roots.map(root => root.agent.sessionId)).toEqual(["c", "a", "b"])
    })

    it("does not pin a subagent out of the tree it belongs to", () => {
        // Pinning a child would have to tear it out of its parent. Its root
        // rises instead, which brings the child with it.
        const roots = forest([agent("a", null), agent("b", null), agent("b1", "b")], { pinned: ["b1", "b"] })

        expect(roots.map(root => root.agent.sessionId)).toEqual(["b", "a"])
        expect(roots[0]!.subagents[0]!.agent.sessionId).toBe("b1")
    })

    it("does not lose an agent to a parentage cycle", () => {
        // Parentage is stamped at spawn and never rewritten, so this should be
        // impossible — but every agent in a cycle has a visible parent, so none
        // becomes a root, and they would vanish while still running. An
        // unreachable running agent is worse than an oddly-drawn one.
        const roots = forest([agent("x", "y"), agent("y", "x")])

        expect(roots).toHaveLength(2)
    })
})

describe("forest children", () => {
    it("orders subagents before procs under the same agent", () => {
        // A conversation is a bigger thing than a shell command, and a burst of
        // short-lived `run` rows must not push a subagent off the window.
        const roots = forest([agent("a", null, [proc("bun test")]), agent("a1", "a")])
        const children = childrenOf(roots[0]!)

        expect(children.map(child => child.kind === "agent" ? child.node.agent.sessionId : child.proc.command))
            .toEqual(["a1", "bun test"])
    })

    it("gives a proc no children of its own", () => {
        // A proc's own children never reach an agent's log — the tree stops
        // where the trace does.
        const roots = forest([agent("a", null, [proc("sleep 3600")])])
        const child = childrenOf(roots[0]!)[0]!

        expect(child.kind).toBe("proc")
    })
})

describe("forest flattened", () => {
    it("indents one level per generation", () => {
        const rows = flatten(forest([agent("a", null), agent("a1", "a"), agent("a1x", "a1")]))

        expect(rows.map(row => row.indent)).toEqual([0, 1, 2])
    })

    it("hangs a subagent's proc under the SUBAGENT, not its root", () => {
        // The case the merge exists for: an agent spawns a subagent which
        // spawns a process. It nests with no reparenting, because the proc
        // comes off the subagent's own log.
        const rows = flatten(forest([agent("a", null), agent("a1", "a", [proc("tail -f log")])]))

        expect(labels(rows)).toEqual(["a", "a1", "tail -f log"])
        expect(rows[2]).toMatchObject({ indent: 2, ownerSessionId: "a1" })
    })

    it("marks only the final child of a group as last", () => {
        const rows = flatten(forest([agent("a", null, [proc("one"), proc("two")]), agent("a1", "a")]))

        // The subagent is NOT last — two procs follow it — and drawing it with
        // `└─` would break the tree's spine.
        expect(rows.map(row => row.last)).toEqual([true, false, false, true])
    })
})
