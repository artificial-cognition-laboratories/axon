import { describe, expect, it } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AxonSession } from "../../src/session"
import { AxonBus } from "@arcforge/core"
import { ring } from "./support/ring"

function blueprint(root: string, sessionId: string) {
    return {
        agent: { name: "@test/agent", version: "0.0.0" },
        paths: { root, data: "data" },
        session: { id: sessionId },
    } as never
}

/**
 * Kernel telemetry in memory is a window: a continuous mind commits over a
 * thousand events a second, and holding the session's every one grew without
 * end. The window says where it begins; the ring on disk keeps everything.
 */
describe("kernel log window", () => {
    it("keeps the newest events, says where it begins, and leaves the disk complete", async () => {
        const root = await mkdtemp(join(tmpdir(), "axon-window-"))
        try {
            const session = await AxonSession({ blueprint: blueprint(root, "s1"), bus: AxonBus() })
            expect(session.kernelFloor).toBe(0)
            const total = 23_000
            const commits: Promise<unknown>[] = []
            for (let tick = 0; tick < total; tick++) commits.push(session.commit("cognet:tick:complete", { tick: tick, durationMs: 1 }))
            await Promise.all(commits)
            expect(session.kernelLog.length).toBeLessThanOrEqual(22_000)
            expect(session.kernelLog.length).toBeGreaterThanOrEqual(20_000)
            expect(session.kernelFloor).toBe(session.kernelLog[0]!.time.seq)
            expect((session.kernelLog.at(-1)!.data as { tick: number }).tick).toBe(total - 1)
            await session.end()
            // Ticks are ring telemetry: every one is on disk there, and none in the log.
            const log = await readFile(join(root, "data", "sessions", "s1.jsonl"), "utf-8")
            expect(log.includes("cognet:tick:complete")).toBe(false)
            const kept = await ring(join(root, "data"), "s1")
            expect(kept.filter(event => event.type === "cognet:tick:complete")).toHaveLength(total)
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    }, 30_000)

    it("is bounded by what its events hold, not only by how many there are", async () => {
        const root = await mkdtemp(join(tmpdir(), "axon-window-"))
        try {
            const session = await AxonSession({ blueprint: blueprint(root, "s1"), bus: AxonBus() })
            // A field a write: 250,000 numbers, about 2MB held. A hundred of them is 200MB by count alone.
            const total = 100
            for (let tick = 0; tick < total; tick++) {
                await session.commit("cognet:component:update", { tick: tick, phase: null, entity: "frame:camera", component: "shapes", value: { values: new Array(250_000).fill(0.4) } })
            }
            expect(session.kernelLog.length).toBeLessThan(40)
            expect(session.kernelLog.length).toBeGreaterThan(10)
            expect(session.kernelFloor).toBe(session.kernelLog[0]!.time.seq)
            expect((session.kernelLog.at(-1)!.data as { tick: number }).tick).toBe(total - 1)
            await session.end()
            // The ring is the record of all of them.
            const kept = await ring(join(root, "data"), "s1")
            expect(kept.filter(event => event.type === "cognet:component:update")).toHaveLength(total)
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    }, 30_000)
})
