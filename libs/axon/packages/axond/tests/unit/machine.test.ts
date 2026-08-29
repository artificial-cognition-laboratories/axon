import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Machine } from "../../src/machine/index.ts"

/**
 * The machine domain.
 *
 * Driven through `Machine()` directly — the same handle `Axond()` wires — so
 * these test what actually runs rather than a stand-in. The GPU probe is the
 * one thing that cannot be asserted on absolutely: this machine may have an
 * NVIDIA card or none, so every assertion about video memory is about the
 * SHAPE of the answer (a number, or an honest null) rather than its value.
 */

const roots: string[] = []
afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function machine(budget?: () => number | null) {
    const root = await mkdtemp(join(tmpdir(), "axond-machine-"))
    roots.push(root)
    return Machine({ residencyRoot: root, ...(budget ? { budget: budget } : {}) })
}

describe("identity", () => {
    test("reports a stable id, or null — never an invented one", async () => {
        const m = await machine()

        const first = m.identity.current()
        const second = m.identity.current()

        // A random fallback would look stable within one process and differ
        // across restarts, silently fragmenting every record that correlates
        // on it. Null is a fact a caller can act on.
        expect(first.id).toBe(second.id)
        if (first.id !== null) expect(first.id).toMatch(/^[0-9a-f]{32}$/)
    })

    test("carries the host facts a remote daemon would need", async () => {
        const m = await machine()

        const identity = m.identity.current()

        expect(identity.hostname.length).toBeGreaterThan(0)
        expect(identity.platform.length).toBeGreaterThan(0)
        expect(identity.arch.length).toBeGreaterThan(0)
    })
})

describe("capacity", () => {
    test("reports what the box has, with unmeasurable vram as null", async () => {
        const m = await machine()

        const capacity = m.hardware.current()

        expect(capacity.cores).toBeGreaterThan(0)
        expect(capacity.ram).toBeGreaterThan(0)
        // NULL IS NOT ZERO. A machine we cannot measure has no known ceiling,
        // and reporting zero would refuse every local model on most machines.
        expect(capacity.vram === null || capacity.vram > 0).toBe(true)
        expect(["nvidia", "apple", "unknown"]).toContain(capacity.vramSource)
    })

    test("an unmeasured gpu names no model rather than inventing one", async () => {
        const m = await machine()
        const capacity = m.hardware.current()

        if (capacity.vramSource === "unknown") {
            expect(capacity.gpu).toBeNull()
            expect(capacity.vram).toBeNull()
        }
    })
})

describe("usage", () => {
    test("a reading is always produced, with unreadable fields null", async () => {
        // The probe must never throw: a poll loop that dies because one GPU
        // query failed stops the whole resource manager.
        const m = await machine()

        const usage = m.samples.now()

        expect(usage.ramAvailable).toBeGreaterThan(0)
        expect(usage.load).toBeGreaterThanOrEqual(0)
        expect(usage.at).toBeGreaterThan(0)
        expect(usage.vramUsed === null || usage.vramUsed >= 0).toBe(true)
    })

    test("history accumulates and is a copy, not the ring", async () => {
        const m = await machine()

        m.samples.now()
        m.samples.now()
        const history = m.samples.history()
        history.length = 0

        // Handing out the ring would let a consumer empty the daemon's own
        // history by tidying its local copy.
        expect(m.samples.history().length).toBe(2)
    })
})

describe("residency", () => {
    test("a hold is recorded and released", async () => {
        const m = await machine()

        const hold = m.residency.take({
            agent: "@test/agent",
            role: "asr",
            model: "hf:whisper-base.en",
            bytes: 250_000_000,
        })
        expect(m.residency.held()).toBe(250_000_000)
        expect(m.residency.live()).toHaveLength(1)

        m.residency.release(hold.id)

        expect(m.residency.held()).toBe(0)
    })

    test("releasing twice is not an error", async () => {
        // Unloading a model that is already gone is a no-op, not a fault.
        const m = await machine()
        const hold = m.residency.take({ agent: "a", role: "asr", model: "m", bytes: 1 })

        m.residency.release(hold.id)

        expect(() => m.residency.release(hold.id)).not.toThrow()
    })

    test("holds carry who is holding them, so a refusal can name something", async () => {
        const m = await machine()

        m.residency.take({ agent: "@cody/barry", role: "asr", model: "hf:whisper", bytes: 10 })

        const [hold] = m.residency.live()
        expect(hold?.agent).toBe("@cody/barry")
        expect(hold?.role).toBe("asr")
        expect(hold?.pid).toBe(process.pid)
    })
})

describe("admission", () => {
    test("refuses what does not fit, and names the holders", async () => {
        // A refusal that says only "no" is unactionable; naming what holds the
        // memory is the difference between a bug report and a decision.
        const m = await machine(() => 1_000)
        m.residency.take({ agent: "@cody/barry", role: "asr", model: "hf:whisper", bytes: 900 })

        const verdict = m.admit(5_000)

        expect(verdict.ok).toBe(false)
        if (!verdict.ok) {
            expect(verdict.wanted).toBe(5_000)
            expect(verdict.holders.some(hold => hold.agent === "@cody/barry")).toBe(true)
        }
    })

    test("admits what fits, reporting the headroom left", async () => {
        const m = await machine(() => 10_000_000_000)

        const verdict = m.admit(1_000)

        expect(verdict.ok).toBe(true)
    })

    test("an unbounded machine admits anything rather than refusing everything", async () => {
        // No declared budget and no measurable card means no KNOWN ceiling.
        // Treating that as zero would make local inference unavailable on most
        // machines in existence.
        const m = await machine(() => null)
        const unbounded = m.hardware.current().vram === null

        const verdict = m.admit(Number.MAX_SAFE_INTEGER)

        if (unbounded) {
            expect(verdict.ok).toBe(true)
            if (verdict.ok) expect(verdict.headroom).toBeNull()
        }
    })

    test("a declared budget wins over the measured hardware", async () => {
        // A user who says 4GB on a 24GB card means it — that is what makes
        // local inference usable on a box that is also running a game.
        const m = await machine(() => 1_000)

        const verdict = m.admit(2_000)

        expect(verdict.ok).toBe(false)
    })
})

describe("polling", () => {
    test("start is idempotent and stop leaves no timer running", async () => {
        const m = await machine()

        m.start()
        m.start()
        m.stop()

        // Nothing to assert beyond it not throwing and not hanging the suite:
        // a stacked timer would keep the process alive past the test.
        expect(m.samples.history().length).toBeGreaterThan(0)
    })

    test("stopping releases this process's holds", async () => {
        // A daemon that exits holding records leaves the machine looking
        // fuller than it is until something else reaps them.
        const m = await machine()
        m.residency.take({ agent: "a", role: "asr", model: "m", bytes: 1 })

        m.stop()

        expect(m.residency.live()).toHaveLength(0)
    })
})
