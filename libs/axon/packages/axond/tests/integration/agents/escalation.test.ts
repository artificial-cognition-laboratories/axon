import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Axond } from "../../../src/axond"
import { Platform } from "@arcforge/platform/platform"
import { TEST_VERSION, TEST_FRAMEWORK } from "../../setup/user"
import { attended, authenticated } from "../../setup/supervised"
import type { PlatformT } from "@arcforge/platform"
import type { InstanceT } from "@arcforge/platform/build/runtime"
import { describe, it, expect } from "bun:test"

/**
 * An escalation reaches the person, across the whole stack.
 *
 * ── Why this test exists ────────────────────────────────────────────────────
 *
 * Every agent runs CONFINED, supervised by the daemon. A policy rule that says
 * "escalate" therefore has to travel agent → link → supervisor → decider, and
 * every piece of that path existed while nothing connected two of the joins:
 * `agent-main.ts` built its runtime without an `escalate`, so the agent's
 * kernel was headless and never raised the question; and `axond.ts` built
 * `Supervise({ cloud, local })` without `decide`, so the supervisor had no
 * answer if it had. `Agent()` even declared an `escalate` option and dropped it
 * on the floor — wiring left over from the in-heap runtime that no longer
 * exists, which is what made the path LOOK connected.
 *
 * The result in a real terminal: "needs approval, and nothing was listening",
 * while the user sat in front of the TUI that was listening.
 *
 * ── Why it is asserted HERE ─────────────────────────────────────────────────
 *
 * Nothing below this level could catch it. The capsule's own tests construct
 * `Capsule({ escalate })` directly, which is exactly the in-heap shape that no
 * longer runs; core's kernel tests pass `escalate` into `Axon()` themselves.
 * Both were green throughout. The defect lived in the JOINS between packages,
 * so the test has to own the whole span: a real daemon, a real box, a real
 * unix socket, and a decider on the far side.
 *
 * `link.run()` is the trigger rather than a wake: it executes code inside the
 * agent's capsule, which is where model-emitted code runs and where the
 * mediator decides. That reaches the same mediation path a model would without
 * needing a provider scripted to emit one.
 */

function disposableName(): string {
    return `test-agent-${crypto.randomUUID().slice(0, 8)}`
}

function linked(instance: InstanceT) {
    if (instance.source.kind === "remote") throw new Error("expected a linked instance")
    return instance.source
}

describe("escalation crosses the daemon", () => {
    it("an undeclared program asks the decider the daemon was given", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))

        const asked: Array<{ agent: string; fn: string }> = []
        const platform = attended(storeDir, async (input, call) => {
            asked.push({ agent: input.agent, fn: (call as { fn: string }).fn })
            return true
        })

        try {
            const name = disposableName()
            const project = await platform.projects.create("agent", { name, dir })
            const instance = await platform.agents.spawn(project)

            // Runs INSIDE the agent's box, through the mediator — the same
            // path model-emitted code takes. The agent declares no policy, so
            // this program is one nobody has written a rule about.
            await linked(instance).agent.link.run(`await process.run("echo hello")`)

            // The question left the box, crossed the link, and reached the
            // decider — bound to the agent it was raised for, because a grant
            // is written against a name.
            expect(asked.map(a => a.fn)).toContain("shell.run:echo")
            expect(asked[0]!.agent).toBe(name)
        } finally {
            await platform.agents.shutdown().catch(() => {})
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    }, 120_000)

    /**
     * The other half: a daemon with nobody to ask must still refuse.
     *
     * This is the posture `axon run` in a script and a cloud deployment have,
     * and it is what the absent decider is FOR — an unattended agent must never
     * be more privileged than an attended one.
     */
    it("a daemon with no decider refuses rather than granting", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))

        // No decider — exactly what apps/tui/cli/cli.ts builds, because a CLI
        // has no interactive surface to ask through.
        const platform: PlatformT = authenticated(storeDir)

        try {
            const project = await platform.projects.create("agent", { name: disposableName(), dir })
            const instance = await platform.agents.spawn(project)

            const result = await linked(instance).agent.link.run(`await process.run("echo hello")`)

            // Refused, and the run reports it rather than the command silently
            // doing nothing.
            const denials = (result as { denials?: unknown[] }).denials ?? []
            expect(denials.length).toBeGreaterThan(0)
        } finally {
            await platform.agents.shutdown().catch(() => {})
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    }, 120_000)
})
