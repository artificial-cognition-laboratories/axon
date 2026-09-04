import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Running } from "../../src/services/running"
import type { AxonInstance } from "@arcforge/types"

/**
 * The running-instance registry, read against a store it does not own.
 *
 * ── Why this needed an escape hatch ─────────────────────────────────────────
 *
 * `Running()` sweeps four well-known store roots under `homedir()`, baked into
 * a module-level constant. That width is CORRECT in production: an observer
 * must see an agent booted by the installed binary and one booted from a source
 * checkout alike, or it reports an idle machine while work is running.
 *
 * It is wrong under test, and in two directions. A test asserting "nothing is
 * running" fails whenever the developer happens to have an agent open — a
 * flake that looks like a bug in the code under test. And `stop()` prunes
 * EVERY root, so a test cleaning up after itself could delete a real record
 * belonging to a live process on the developer's machine.
 *
 * Neither was reachable before, because the roots were frozen at import and
 * nothing could redirect them. The daemon's Registry already carried an
 * `isolated` flag for exactly this; `Running` now spells it the same way.
 *
 * ── What these pin ──────────────────────────────────────────────────────────
 *
 * That isolation actually isolates — reads AND prunes — because a flag that
 * only narrows writes would leave the destructive half pointed at the real
 * store while reading as safe.
 */

let store: string
let other: string

/** A record for a process that is definitely alive: this one. */
function instance(sessionId: string): AxonInstance {
    return {
        pid: process.pid,
        sessionId,
        agentName: "@test/probe",
        projectRoot: "/tmp/probe",
        dataRoot: "/tmp/probe/.agent/data",
        startedAt: new Date().toISOString(),
    }
}

/** Write a record directly, as another store's daemon would have. */
function seed(root: string, sessionId: string): void {
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, `${sessionId}.json`), JSON.stringify(instance(sessionId)))
}

beforeEach(() => {
    store = mkdtempSync(join(tmpdir(), "running-own-"))
    other = mkdtempSync(join(tmpdir(), "running-other-"))
})

afterEach(() => {
    rmSync(store, { recursive: true, force: true })
    rmSync(other, { recursive: true, force: true })
})

describe("Running, isolated", () => {
    it("lists what it registered", () => {
        const running = Running({ root: store, isolated: true })
        running.start(instance("own-1"))

        expect(running.list().map(entry => entry.sessionId)).toEqual(["own-1"])
        running.dispose()
    })

    it("reads only its own root", () => {
        // The default sweeps every well-known store. Isolated must not — or a
        // test's view of "what is running" includes the developer's real work.
        seed(other, "someone-elses")
        const running = Running({ root: store, isolated: true })
        running.start(instance("own-1"))

        const seen = running.list().map(entry => entry.sessionId)

        expect(seen).toEqual(["own-1"])
        expect(seen).not.toContain("someone-elses")
        running.dispose()
    })

    it("reports only its own root as a read root", () => {
        const running = Running({ root: store, isolated: true })

        expect(running.roots).toEqual([store])
        running.dispose()
    })

    it("prunes only its own root — stop() cannot reach another store", () => {
        // The destructive half. `stop()` sweeps every root by design, so an
        // isolation flag that narrowed reads alone would still let a test
        // delete a live record on the machine running it.
        seed(other, "someone-elses")
        const running = Running({ root: store, isolated: true })
        running.start(instance("someone-elses"))

        running.stop("someone-elses")

        expect(existsSync(join(other, "someone-elses.json"))).toBe(true)
        expect(existsSync(join(store, "someone-elses.json"))).toBe(false)
        running.dispose()
    })
})

describe("Running, default", () => {
    it("still reads every well-known root", () => {
        // The width is the point in production, and this asserts the flag is
        // opt-in rather than a behaviour change for everyone.
        const running = Running({ root: store })

        expect(running.roots.length).toBeGreaterThan(1)
        expect(running.roots).toContain(store)
        running.dispose()
    })
})
