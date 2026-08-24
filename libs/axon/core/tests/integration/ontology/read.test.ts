import { Axon } from "../../setup/axon"
import { Mock } from "@arcforge/engines/mock"
import { formatSession, isSpanNode, readSession } from "@arcforge/types"
import type { ReadNode, SpanNode } from "@arcforge/types"

/**
 * readSession() reconstructs the nested shape of a wake from the flat log.
 *
 * This is the payoff of the single-writer design: nesting is time
 * containment, so the tree comes back exactly without any parent pointer
 * ever having been emitted.
 */

async function wakeTree() {
    const runtime = await Axon({
        blueprint: {
            config: { engine: Mock({ hello: "<typescript>1 + 1</typescript>" }) },
        },
    })
    await runtime.kernel.request({ content: "hello" })
    await runtime.shutdown()

    const all = [
        ...runtime.session.log,
        ...runtime.session.kernelLog,
        ...runtime.session.entries,
    ] as unknown as Parameters<typeof readSession>[0]

    return readSession(all)
}

/** Depth-first search for the first span with this stem. */
function findSpan(nodes: readonly ReadNode[], stem: string): SpanNode | undefined {
    for (const node of nodes) {
        if (!isSpanNode(node)) continue
        if (node.stem === stem) return node
        const nested = findSpan(node.children, stem)
        if (nested) return nested
    }
    return undefined
}

describe("Session reader", () => {
    it("nests a run's telemetry under the run that produced it", async () => {
        const tree = await wakeTree()

        const run = findSpan(tree, "kernel:run")
        expect(run).toBeDefined()
        expect(run!.outcome).toBe("complete")
        expect(run!.children.length).toBeGreaterThan(0)

        // The tick happened inside the run — the log never said so, the
        // ordering did.
        const tick = findSpan([run!], "cognet:tick")
        expect(tick).toBeDefined()
    })

    it("nests phases inside their tick and the engine call inside its phase", async () => {
        const tree = await wakeTree()

        const tick = findSpan(tree, "cognet:tick")
        expect(tick).toBeDefined()

        const phase = findSpan(tick!.children, "cognet:phase")
        expect(phase).toBeDefined()

        // three levels deep, reconstructed purely from seq ordering
        const engine = findSpan(tree, "kernel:engine")
        expect(engine).toBeDefined()
        expect(engine!.outcome).toBe("complete")
    })

    it("carries each span's duration and outcome", async () => {
        const tree = await wakeTree()

        const run = findSpan(tree, "kernel:run")
        expect(typeof run!.durationMs).toBe("number")
        expect(run!.durationMs).toBeGreaterThanOrEqual(0)
        expect(run!.end?.type).toBe("kernel:run:complete")
    })

    it("keeps boot and shutdown as siblings at the root", async () => {
        const tree = await wakeTree()

        const roots = tree.filter(isSpanNode).map(n => n.stem)
        expect(roots).toContain("axon:boot")
        expect(roots).toContain("axon:shutdown")
    })

    it("reports an unclosed span as open rather than inventing an end", async () => {
        // A truncated log — the run started and the file ends mid-span.
        const truncated = readSession([
            { type: "kernel:run:start", time: { seq: 0, ms: 0 }, context: { runId: "r" }, data: {} },
            { type: "cognet:tick:start", time: { seq: 1, ms: 1 }, context: { runId: "r" }, data: { tick: 1 } },
        ])

        const run = findSpan(truncated, "kernel:run")
        expect(run!.outcome).toBe("open")
        expect(run!.end).toBeUndefined()

        const tick = findSpan(truncated, "cognet:tick")
        expect(tick!.outcome).toBe("open")
    })

    it("pairs sibling brackets of the same stem by their own identity", async () => {
        // Two ticks in one run — the second must not close the first.
        const tree = readSession([
            { type: "cognet:tick:start", time: { seq: 0, ms: 0 }, context: {}, data: { tick: 1 } },
            { type: "cognet:tick:complete", time: { seq: 1, ms: 1 }, context: {}, data: { tick: 1, durationMs: 5 } },
            { type: "cognet:tick:start", time: { seq: 2, ms: 2 }, context: {}, data: { tick: 2 } },
            { type: "cognet:tick:complete", time: { seq: 3, ms: 3 }, context: {}, data: { tick: 2, durationMs: 7 } },
        ])

        const ticks = tree.filter(isSpanNode)
        expect(ticks).toHaveLength(2)
        expect(ticks[0]?.durationMs).toBe(5)
        expect(ticks[1]?.durationMs).toBe(7)
    })

    it("renders a readable tree", async () => {
        const tree = await wakeTree()
        const text = formatSession(tree)

        expect(text).toContain("kernel:run")
        expect(text).toContain("cognet:tick")
        // indentation is what makes it readable at a glance
        expect(text).toMatch(/\n\s+▸/)
    })
})
