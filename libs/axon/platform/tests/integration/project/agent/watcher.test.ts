import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform } from "@arcforge/platform/platform"
import { TEST_USER, TEST_VERSION, TEST_FRAMEWORK } from "../../../setup/user"
import { describe, it, expect } from "bun:test"

function disposableName(): string {
    return `@${TEST_USER.username}/test-agent-${crypto.randomUUID().slice(0, 8)}`
}

// Real fs watch events + the watcher's own 100ms debounce — give every
// assertion enough margin to observe a real, asynchronous OS-level event.
//
// Only used for NEGATIVE assertions ("nothing fired"), which genuinely have
// to wait out the window. A positive assertion polls instead — see settle().
const SETTLE_MS = 300

/**
 * Wait until `seen` contains a matching path, or give up.
 *
 * A fixed sleep is the wrong tool for "did this event arrive": it has to be
 * long enough for the slowest case, which makes every other case pay, and it
 * still fails whenever the machine is busier than whoever chose the number.
 * Under `bun test --parallel=4` that is exactly what happened — these tests
 * passed alone in 3.7s and timed out in the suite, intermittently and on a
 * different test each run.
 *
 * Polling turns the wait into "as long as it takes, up to a real ceiling",
 * so the fast path stays fast and the loaded path stops flaking.
 */
async function settle(seen: readonly string[], match: string, timeoutMs = 4_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (seen.some(path => path.includes(match))) return
        await Bun.sleep(25)
    }
}

describe("agent project: watcher", () => {
    it("is inert until start() — a write beforehand never fires onChange", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const project = await platform.projects.create("agent", { name, dir })

            const seen: string[] = []
            project.watcher.onChange(path => seen.push(path))

            await writeFile(join(project.root, "src", "boot.vue"), "<template>changed</template>\n")
            await Bun.sleep(SETTLE_MS)

            expect(seen).toEqual([])
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("fires onChange with the changed path once started", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const project = await platform.projects.create("agent", { name, dir })

            const seen: string[] = []
            project.watcher.onChange(path => seen.push(path))
            await project.watcher.start()

            await writeFile(join(project.root, "src", "boot.vue"), "<template>changed</template>\n")
            await settle(seen, "boot.vue")

            expect(seen.some(path => path.includes("boot.vue"))).toBe(true)
            project.watcher.stop()
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("debounces a burst of rapid writes into a single callback", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const project = await platform.projects.create("agent", { name, dir })

            let calls = 0
            project.watcher.onChange(() => { calls++ })
            await project.watcher.start()

            for (let i = 0; i < 5; i++) {
                await writeFile(join(project.root, "src", "boot.vue"), `<template>${i}</template>\n`)
            }
            await Bun.sleep(SETTLE_MS)

            expect(calls).toBe(1)
            project.watcher.stop()
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("ignores changes inside default-ignored directories", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const project = await platform.projects.create("agent", { name, dir })

            const seen: string[] = []
            project.watcher.onChange(path => seen.push(path))
            await project.watcher.start()

            await mkdir(join(project.root, ".agent"), { recursive: true })
            await writeFile(join(project.root, ".agent", "scratch.txt"), "ignored\n")
            await Bun.sleep(SETTLE_MS)

            expect(seen).toEqual([])
            project.watcher.stop()
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("ignores changes inside data/sessions — the agent's own session writes must never self-trigger a reload", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const project = await platform.projects.create("agent", { name, dir })

            // Created BEFORE watching. A scaffold no longer writes data/, and
            // only data/sessions is ignored — so making the tree while the
            // watcher runs fires a legitimate change on data/ itself, which is
            // not what this test is about. The claim is that writes INSIDE
            // data/sessions are ignored.
            await mkdir(join(project.root, "data", "sessions"), { recursive: true })

            const seen: string[] = []
            project.watcher.onChange(path => seen.push(path))
            await project.watcher.start()

            await writeFile(join(project.root, "data", "sessions", "session.jsonl"), "{}\n")
            await Bun.sleep(SETTLE_MS)

            expect(seen).toEqual([])
            project.watcher.stop()
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("ignores data\\sessions on Windows path separators too", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const project = await platform.projects.create("agent", { name: disposableName(), dir })

            // fs.watch() on this host never emits a backslash path, so the
            // watcher's own predicate is the only way to exercise the
            // normalization that makes Windows behave like Unix here.
            expect(project.watcher.ignores("data\\sessions\\session.jsonl")).toBe(true)
            expect(project.watcher.ignores("data\\knowledge\\notes.md")).toBe(false)
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    }, 60_000)

    it("still fires for changes elsewhere in data/ — only sessions is self-write noise, other data is real project content", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const project = await platform.projects.create("agent", { name, dir })

            const seen: string[] = []
            project.watcher.onChange(path => seen.push(path))
            await project.watcher.start()

            await mkdir(join(project.root, "data", "knowledge"), { recursive: true })
            await writeFile(join(project.root, "data", "knowledge", "notes.md"), "# notes\n")
            await settle(seen, "notes.md")

            expect(seen.some(path => path.includes("notes.md"))).toBe(true)
            project.watcher.stop()
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("stop() actually stops — a write afterward never fires onChange", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const project = await platform.projects.create("agent", { name, dir })

            const seen: string[] = []
            project.watcher.onChange(path => seen.push(path))
            await project.watcher.start()
            project.watcher.stop()

            await writeFile(join(project.root, "src", "boot.vue"), "<template>changed</template>\n")
            await Bun.sleep(SETTLE_MS)

            expect(seen).toEqual([])
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("start()/stop() are idempotent", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const project = await platform.projects.create("agent", { name, dir })

            await project.watcher.start()
            await project.watcher.start()
            project.watcher.stop()
            project.watcher.stop()

            expect(true).toBe(true) // reaching here without throwing is the assertion
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("onChange()'s returned unsubscribe stops that listener without affecting others", async () => {
        const storeDir = await mkdtemp(join(tmpdir(), "axon-test-store-"))
        const dir = await mkdtemp(join(tmpdir(), "axon-test-dir-"))
        const name = disposableName()

        try {
            const platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: storeDir })
            const project = await platform.projects.create("agent", { name, dir })

            let unsubscribedCalls = 0
            let staysSubscribedCalls = 0
            const unsubscribe = project.watcher.onChange(() => { unsubscribedCalls++ })
            project.watcher.onChange(() => { staysSubscribedCalls++ })
            await project.watcher.start()

            unsubscribe()

            await writeFile(join(project.root, "src", "boot.vue"), "<template>changed</template>\n")
            await Bun.sleep(SETTLE_MS)

            expect(unsubscribedCalls).toBe(0)
            expect(staysSubscribedCalls).toBe(1)
            project.watcher.stop()
        } finally {
            await rm(storeDir, { recursive: true, force: true })
            await rm(dir, { recursive: true, force: true })
        }
    })
})
