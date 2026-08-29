import { afterEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Axond } from "../../src/index.ts"

/**
 * The daemon's shell — is it up, can it start, can it stop.
 *
 * Driven through `Axond()` DIRECTLY, with no socket and no subprocess. That is
 * the property the two-root design buys: the composition root is the same
 * object `bin/axond.ts` boots, so exercising it here tests what actually
 * runs — and the transport gets its own suite rather than every domain test
 * paying for a live server.
 */

const roots: string[] = []
afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function daemon() {
    const root = await mkdtemp(join(tmpdir(), "axond-test-"))
    roots.push(root)
    return Axond({ root: root, version: "9.9.9" })
}

describe("daemon lifecycle", () => {
    test("a fresh daemon reports itself down", async () => {
        const axond = await daemon()

        expect(axond.lifecycle.status()).toEqual({ running: false })
        expect(axond.lifecycle.pid()).toBeNull()
    })

    test("serving claims the pidfile and reports up", async () => {
        const axond = await daemon()
        try {
            await axond.serve()

            const state = axond.lifecycle.status()
            expect(state.running).toBe(true)
            // Narrowed rather than asserted loosely: a stopped daemon carries
            // no pid, and the type says so.
            if (state.running) {
                expect(state.pid).toBe(process.pid)
                expect(state.version).toBe("9.9.9")
            }
        } finally {
            await axond.shutdown()
        }
    })

    test("a second serve on the same root is refused", async () => {
        // Two daemons would each believe they owned the GPU — the one failure
        // the whole design exists to prevent.
        const axond = await daemon()
        try {
            await axond.serve()
            const second = Axond({ root: axond.paths.root })

            await expect(second.serve()).rejects.toThrow(/already/i)
        } finally {
            await axond.shutdown()
        }
    })

    test("shutdown releases the pidfile and the socket", async () => {
        const axond = await daemon()
        await axond.serve()

        await axond.shutdown()

        expect(axond.lifecycle.status()).toEqual({ running: false })
        // A socket left behind is what makes the NEXT start fail with
        // EADDRINUSE against nothing.
        expect(existsSync(axond.paths.socket)).toBe(false)
    })

    test("shutdown is idempotent", async () => {
        const axond = await daemon()
        await axond.serve()

        await axond.shutdown()
        await axond.shutdown()

        expect(axond.lifecycle.status()).toEqual({ running: false })
    })

    test("down reports false when nothing was running", async () => {
        // "Stopped nothing" and "stopped something" are different answers, and
        // a caller printing "stopped" for both would lie.
        const axond = await daemon()

        expect(axond.lifecycle.down()).toBe(false)
    })

    test("a stale pidfile does not make a dead daemon look alive", async () => {
        // A process killed with -9 leaves one behind. Trusting it would report
        // a daemon that is gone, and refuse to start a real one.
        const axond = await daemon()
        await Bun.write(axond.paths.pid, "999999")

        expect(axond.lifecycle.pid()).toBeNull()
        expect(axond.lifecycle.status()).toEqual({ running: false })
    })
})

describe("domains", () => {
    test("machine, agents and models answer, because they are wired", async () => {
        const axond = await daemon()

        expect(axond.machine.state().capacity.cores).toBeGreaterThan(0)
        expect(Array.isArray(axond.agents.state().agents)).toBe(true)
        expect(Array.isArray(axond.models.state().resident)).toBe(true)
    })

    test("an unwired domain throws rather than answering emptily", async () => {
        // Invariant 7: a stub returning [] is indistinguishable from a real
        // answer, and the next caller builds on it without knowing.
        const axond = await daemon()

        expect(() => axond.schedule.state()).toThrow(/not wired/i)
    })
})
