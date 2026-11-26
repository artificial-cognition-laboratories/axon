import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AxonBlueprint, CapsulePolicy } from "@arcforge/types"
import { spawnConfined } from "../../../src/confined"
import { describe, it, expect, afterEach } from "bun:test"

/**
 * An agent that exits before it is up must say WHY.
 *
 * Regression for AX-AGENT-006 on 2.0.246: "the agent process exited with code
 * 0 before connecting", and nothing else. The agent's last words were lost two
 * ways — stderr was read by a fire-and-forget loop the exit arm did not wait
 * for, and stdout went to a terminal a TUI owns — so the report named the
 * symptom and dropped the cause.
 */
describe("spawnConfined — an agent that exits during boot", () => {
    const roots: string[] = []
    afterEach(() => {
        for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
    })

    function boot(source: string) {
        const root = mkdtempSync(join(tmpdir(), "axon-boot-exit-"))
        roots.push(root)
        const entry = join(root, "main.ts")
        writeFileSync(entry, source)
        return spawnConfined({
            sessionId: `boot-exit-${process.pid}-${Date.now()}-${roots.length}`,
            blueprint: { paths: { root: root }, tools: [], env: {} } as unknown as AxonBlueprint,
            policy: { isolation: "none" } as CapsulePolicy,
            services: { async *infer() {}, commit: () => {} } as never,
            entrypoint: entry,
            onError: () => {},
        })
    }

    it("carries what the agent wrote to stderr, even when it exits 0", async () => {
        await expect(boot(`process.stderr.write("cognet bundle is stale\\n"); process.exit(0)`)).rejects.toMatchObject({
            context: { code: 0, stage: "spawned" },
            message: expect.stringContaining("cognet bundle is stale"),
        })
    })

    it("falls back to what it wrote to stdout", async () => {
        await expect(boot(`console.log("no agent.ts in this directory"); process.exit(0)`)).rejects.toMatchObject({
            message: expect.stringContaining("no agent.ts in this directory"),
        })
    })

    it("says plainly when it printed nothing", async () => {
        await expect(boot(`process.exit(0)`)).rejects.toMatchObject({
            message: expect.stringContaining("printed nothing"),
        })
    })
})
