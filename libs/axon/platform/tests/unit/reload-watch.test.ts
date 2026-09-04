import { describe, it, expect } from "bun:test"
import { ReloadWatch, RELOAD_TAIL_MS } from "@arcforge/platform/build/runtime/reload-watch"
import type { WatcherT } from "@arcforge/platform/build/project"

/**
 * Hot reload on file change, and the guards that keep it from looping.
 *
 * ── What was broken ─────────────────────────────────────────────────────────
 *
 * Nothing watched an agent's files. `AgentOpts.watch` was declared, documented
 * as "Default true", and read by NOTHING; `Project()` built a watcher whose
 * comment claimed "Agent does, for dev" and `Agent()` never called start().
 * The only started watcher in the tree belonged to the profile, and it ignores
 * `agents/` outright — so saving a `.env`, a tool, or axon.config.ts reloaded
 * nothing. Reloads users DID see came from the profile watcher firing
 * reloadAll() for unrelated reasons, which is why the gap read as "`.env`
 * specifically doesn't reload" rather than "nothing does".
 *
 * ── Why the guards are the subject ──────────────────────────────────────────
 *
 * A reload loop is the failure this feature creates if built naively. An agent
 * with a microphone once reloaded ~1700 times in two minutes — the sensory
 * ring wrote every 32ms and each write triggered a reload, so it never
 * finished booting before the next began. Runtime output now lives under
 * `.agent/` which the watcher prunes wholesale, but a feature whose worst case
 * is "the agent never runs again" earns tests about the guards rather than
 * only about the happy path.
 *
 * Driven through a FAKE watcher: the guards are ordering rules over a change
 * callback, and a real fs watcher would test the filesystem's debounce rather
 * than ours.
 */

/** A watcher whose changes the test fires by hand. */
function fakeWatcher() {
    const listeners = new Set<(path: string) => void>()
    let started = false
    let stopped = false
    let duringDepth = 0

    const watcher = {
        start: async () => { started = true },
        stop: () => { stopped = true },
        onChange(listener: (path: string) => void) {
            listeners.add(listener)
            return () => listeners.delete(listener)
        },
        async during<T>(fn: () => Promise<T>): Promise<T> {
            duringDepth++
            try { return await fn() } finally { duringDepth-- }
        },
        ignores: () => false,
    } as unknown as WatcherT

    return {
        watcher,
        get started() { return started },
        get stopped() { return stopped },
        get listenerCount() { return listeners.size },
        get inDuring() { return duringDepth > 0 },
        fire: (path = "axon.config.ts") => { for (const l of listeners) l(path) },
    }
}

const tick = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe("ReloadWatch: it actually reloads", () => {
    it("reloads when a file changes", async () => {
        // The whole reported bug in one assertion.
        const fake = fakeWatcher()
        let reloads = 0
        const stop = ReloadWatch({ watcher: fake.watcher, reload: async () => { reloads++ } })

        fake.fire()
        await tick(10)

        expect(reloads).toBe(1)
        stop()
    })

    it("starts the watcher", async () => {
        // `Project()` built one and nobody ever started it, which is exactly
        // how a watched project watched nothing.
        const fake = fakeWatcher()
        const stop = ReloadWatch({ watcher: fake.watcher, reload: async () => {} })

        await tick(5)

        expect(fake.started).toBe(true)
        stop()
    })
})

describe("ReloadWatch: the loop guards", () => {
    it("does not start a second reload while one is running", async () => {
        // Re-entrancy. Without this a slow reload and a busy directory
        // interleave into an unbounded stack of rescans.
        const fake = fakeWatcher()
        let reloads = 0
        const stop = ReloadWatch({
            watcher: fake.watcher,
            reload: async () => { reloads++; await tick(60) },
        })

        fake.fire()
        await tick(5)
        fake.fire()
        fake.fire()
        await tick(10)

        expect(reloads).toBe(1)
        stop()
    })

    it("ignores changes arriving in the tail after a reload returns", async () => {
        // A reload's own writes land slightly after it resolves. Reacting to
        // them is the loop: reload writes, write triggers reload, forever.
        const fake = fakeWatcher()
        let reloads = 0
        const stop = ReloadWatch({ watcher: fake.watcher, reload: async () => { reloads++ } })

        fake.fire()
        await tick(20)
        fake.fire()
        await tick(20)

        expect(reloads).toBe(1)
        stop()
    })

    it("reloads again once the tail window has passed", async () => {
        // The window must EXPIRE. A guard that never reopens is a watcher that
        // works once, which is worse than one that does not work at all
        // because it looks fine in a manual test.
        const fake = fakeWatcher()
        let reloads = 0
        const stop = ReloadWatch({ watcher: fake.watcher, reload: async () => { reloads++ } })

        fake.fire()
        await tick(20)
        await tick(RELOAD_TAIL_MS + 50)
        fake.fire()
        await tick(20)

        expect(reloads).toBe(2)
        stop()
    })

    it("keeps working after a reload throws", async () => {
        // A user saving a half-written config makes the rescan fail. The
        // watcher must survive it — otherwise one typo ends hot reload for
        // the rest of the session, silently.
        const fake = fakeWatcher()
        let reloads = 0
        const stop = ReloadWatch({
            watcher: fake.watcher,
            reload: async () => { reloads++; throw new Error("half-written config") },
        })

        fake.fire()
        await tick(20)
        await tick(RELOAD_TAIL_MS + 50)
        fake.fire()
        await tick(20)

        expect(reloads).toBe(2)
        stop()
    })
})

describe("ReloadWatch: teardown", () => {
    it("unsubscribes and stops the watcher", async () => {
        // A watcher outliving its agent holds an fs handle open and reloads a
        // runtime that is gone — and every boot would add another.
        const fake = fakeWatcher()
        const stop = ReloadWatch({ watcher: fake.watcher, reload: async () => {} })

        expect(fake.listenerCount).toBe(1)
        stop()

        expect(fake.listenerCount).toBe(0)
        expect(fake.stopped).toBe(true)
    })

    it("does not reload after being stopped", async () => {
        const fake = fakeWatcher()
        let reloads = 0
        const stop = ReloadWatch({ watcher: fake.watcher, reload: async () => { reloads++ } })

        stop()
        fake.fire()
        await tick(20)

        expect(reloads).toBe(0)
    })
})
