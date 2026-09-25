import { describe, expect, it } from "bun:test"
import { Instances } from "../../src/build/runtime/instances"

/**
 * A spawn can name a parent THIS process cannot see.
 *
 * Subagents are spawned by agent code shelling out — `axon @x -p "…" --parent
 * <id>` — which runs in a fresh CLI process whose instance registry is empty,
 * while the parent is alive in a different process entirely. The local lookup
 * therefore always misses, and before this a `--parent` could only ever have
 * named something in the same heap: the one case that never happens.
 *
 * The daemon can answer, because it sees every spawn and writes every record.
 * `lineage()` is that seam. Without it a subagent is a ROOT — flat in the
 * agent tree, and outliving the agent that asked for it because nothing links
 * the two.
 */

/** A supervisor that knows one agent, as the daemon's registry would. */
function supervisor(known: Record<string, { rootSessionId: string; depth: number }>) {
    return {
        lineage: (sessionId: string) => known[sessionId] ?? null,
        supervise: async () => { throw new Error("not reached") },
    }
}

function instances(daemon?: ReturnType<typeof supervisor>) {
    return Instances({
        ...(daemon ? { daemon } : {}),
        store: {} as never,
        projects: {} as never,
        resolve: {} as never,
        cwd: "/tmp",
        cloud: {} as never,
        host: {} as never,
    } as never)
}

describe("cross-process parentage", () => {
    it("refuses a parent nothing has heard of", async () => {
        // A stale or invented id must not silently produce a rooted child.
        const runtime = instances(supervisor({}))
        await expect(runtime.spawn("agent", { parentSessionId: "nope" }))
            .rejects.toThrow(/PARENT_INSTANCE_NOT_RUNNING|Parent Agent Not Running/)
    })

    it("refuses when there is no supervisor to ask", async () => {
        // No daemon means no way to resolve a non-local parent. Failing is
        // right: the alternative is a child that claims a parent it never had.
        const runtime = instances()
        await expect(runtime.spawn("agent", { parentSessionId: "anything" }))
            .rejects.toThrow(/PARENT_INSTANCE_NOT_RUNNING|Parent Agent Not Running/)
    })

    it("accepts a parent only the supervisor knows", async () => {
        // The real case. The lookup gets past the parentage guard and fails
        // LATER, at the supervise() call — which proves the guard admitted it.
        const runtime = instances(supervisor({ live: { rootSessionId: "root-1", depth: 2 } }))
        await expect(runtime.spawn("agent", { parentSessionId: "live" }))
            .rejects.toThrow(/not reached|resolve/)
    })
})
