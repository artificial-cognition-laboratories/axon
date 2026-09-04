import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Agents } from "../../src/agents/index.ts"

/**
 * What one agent may create, enforced where every spawn passes through.
 *
 * Depth caps recursion, children caps one agent's fan-out, descendants caps the
 * tree beneath one root. They exist because the caller is CODE rather than a
 * person: a loop that spawns on every tick costs real money and real memory,
 * and nothing else is counting.
 *
 * They used to live in the platform's `Requests`, which guards the in-process
 * host bridge — the only caller-initiated spawn route that existed when they
 * were written. An agent shelling out to `axon <ref> --parent <id>` bypassed
 * all three. The daemon is the only thing every spawn passes through and the
 * only thing that sees the whole graph, so enforcing here covers both routes
 * with one implementation rather than two that can disagree.
 */

const roots: string[] = []
afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/**
 * A daemon whose registry sees ONLY this test's records.
 *
 * `isolated` matters: without it a Registry also reads the machine-wide roots,
 * so a developer's own running agents count toward the limits under test and
 * the result depends on what happens to be up. That is right for a real daemon
 * — one machine, one view — and wrong for a test asserting a count.
 */
async function daemon() {
    const root = await mkdtemp(join(tmpdir(), "axond-limits-"))
    roots.push(root)
    return { root, agents: Agents({ root: join(root, "running"), isolated: true }) }
}

/** Publish a record directly — the graph, without booting real agents. */
function record(d: Awaited<ReturnType<typeof daemon>>, over: Record<string, unknown>) {
    // `process.pid` because the registry reaps any record whose pid is not
    // alive: a fake one vanishes before it can be counted, which is the
    // registry doing its job. This process is genuinely running.
    d.agents.registry.start({
        sessionId: "x", agent: "@test/a", pid: process.pid, projectRoot: "/a", dataRoot: "/a/data",
        startedAt: new Date().toISOString(), ...over,
    } as never)
}

/** Spawning under `parent` — rejected by a limit, or refused for want of a supervisor. */
async function spawnUnder(d: Awaited<ReturnType<typeof daemon>>, parent: string) {
    return d.agents.supervise({
        sessionId: "child", blueprint: {}, agent: "@test/a",
        projectRoot: "/a", dataRoot: "/a/data", parentSessionId: parent,
    } as never)
}

describe("subagent limits", () => {
    test("refuses a spawn past the depth cap", async () => {
        const axond = await daemon()
        record(axond, { sessionId: "deep", rootSessionId: "root", depth: 4 })

        await expect(spawnUnder(axond, "deep")).rejects.toThrow(/depth/i)
    })

    test("refuses a spawn past one agent's fan-out", async () => {
        const axond = await daemon()
        record(axond, { sessionId: "parent", rootSessionId: "parent", depth: 0 })
        for (let n = 0; n < 4; n++) {
            record(axond, { sessionId: `child-${n}`, parentSessionId: "parent", rootSessionId: "parent", depth: 1 })
        }

        await expect(spawnUnder(axond, "parent")).rejects.toThrow(/children/i)
    })

    test("refuses a spawn past the whole tree's budget", async () => {
        const axond = await daemon()
        record(axond, { sessionId: "root", rootSessionId: "root", depth: 0 })
        // Spread across parents so the CHILD cap is not what refuses this.
        for (let n = 0; n < 12; n++) {
            record(axond, { sessionId: `d-${n}`, parentSessionId: `p-${n % 6}`, rootSessionId: "root", depth: 2 })
        }

        await expect(spawnUnder(axond, "root")).rejects.toThrow(/descendants/i)
    })

    test("says nothing about a parent it has never heard of", async () => {
        // Not this check's error to raise: the spawn path itself refuses an
        // unknown parent, and reporting a LIMIT for one would name the wrong
        // problem entirely.
        const axond = await daemon()
        await expect(spawnUnder(axond, "ghost")).rejects.toThrow(/DAEMON_NOT_WIRED|credential/i)
    })

    test("admits a spawn inside every limit", async () => {
        // The control. Getting as far as "no supervisor" proves the limits
        // admitted it — this daemon has no credential to boot anything with.
        const axond = await daemon()
        record(axond, { sessionId: "parent", rootSessionId: "parent", depth: 0 })

        await expect(spawnUnder(axond, "parent")).rejects.toThrow(/DAEMON_NOT_WIRED|credential/i)
    })
})
