import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { authenticated } from "../../setup/supervised"
import type { InstanceT } from "@arcforge/platform/build/runtime"
import { describe, it, expect } from "bun:test"

/**
 * Interrupting a running agent must not reject anything nobody is holding.
 *
 * The report: pressing Escape in the TUI produced
 * `Runtime Error / The operation was aborted.` on VTerm's fatal boundary — an
 * unhandled rejection, not a rendered failure. The daemon runs IN-PROCESS in
 * the TUI, so a floating promise on the supervisor side surfaces there.
 *
 * `useAgents` guards the paths it knows about: the linked wake is wrapped in a
 * cancellation gate, and `flushQueue` catches its own ingest failure. So the
 * escape is somewhere those do not cover, which is why this reproduces at the
 * SUPERVISOR level rather than through the composable — the same process the
 * TUI is, without a terminal in the way.
 */

function disposableName(): string {
    return `test-agent-${crypto.randomUUID().slice(0, 8)}`
}

function linked(instance: InstanceT) {
    if (instance.source.kind === "remote") throw new Error("expected a linked instance")
    return instance.source
}

describe("interrupting a wake", () => {
    it("rejects nothing into the void", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))

        /*
         * Catch what would otherwise reach VTerm's fatal boundary.
         *
         * An unhandled rejection is exactly the failure mode under test, so it
         * is recorded rather than allowed to kill the run — a test that died
         * the same way the TUI does would report a crash, not a diagnosis.
         */
        const unhandled: unknown[] = []
        const onUnhandled = (reason: unknown) => unhandled.push(reason)
        process.on("unhandledRejection", onUnhandled)

        const platform = authenticated(storeDir)
        try {
            const project = await platform.projects.create("agent", { name: disposableName(), dir })
            const instance = await platform.agents.spawn(project)
            const link = linked(instance).agent.link

            // Something slow enough to still be running when the interrupt
            // lands. `run` executes inside the agent's capsule, which is where
            // an interrupt actually has work to stop.
            const running = link.run(`await new Promise(r => setTimeout(r, 10_000))`)

            await Bun.sleep(500)
            link.interrupt("user")

            // The call itself may settle either way — interrupted is a settled
            // outcome, and a rejection here is the CALLER's to handle. What
            // must not happen is a rejection with no caller at all.
            await running.catch(() => undefined)

            // Give any floating promise a turn to reject.
            await Bun.sleep(1_000)

            expect(unhandled.map(String)).toEqual([])
        } finally {
            process.off("unhandledRejection", onUnhandled)
            await platform.agents.shutdown().catch(() => undefined)
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    }, 120_000)
})
