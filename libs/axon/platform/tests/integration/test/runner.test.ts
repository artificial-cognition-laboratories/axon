import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TestRunner } from "@arcforge/platform/test"

async function fixture(source: string): Promise<{ root: string; file: string }> {
    const root = await mkdtemp(join(tmpdir(), "axon-test-runner-"))
    const file = "lifecycle.test.ts"
    await Bun.write(join(root, file), source)
    return { root, file }
}

describe("TestRunner", () => {
    it("projects native Bun suites, hooks, cases, skips, todos, failures, and console output", async () => {
        const { root, file } = await fixture(`
            describe("root", () => {
                beforeEach(() => console.log("setup"))

                it("passes", () => expect(1).toBe(1))
                it("fails", () => expect(1).toBe(2))
                it.skip("skipped", () => {})
                it.todo("later")
            })
        `)

        try {
            const result = await TestRunner().run({ cwd: root, files: file })
            const types = result.events.map(event => event.type)

            expect(result.status).toBe("failed")
            expect(types).toContain("test:run:start")
            expect(types).toContain("test:suite:declare")
            expect(types).toContain("test:suite:start")
            expect(types).toContain("test:hook:start")
            expect(types).toContain("test:hook:complete")
            expect(types).toContain("test:case:pass")
            expect(types).toContain("test:case:fail")
            expect(types).toContain("test:case:skip")
            expect(types).toContain("test:case:todo")
            expect(types).toContain("test:console")
            expect(types.at(-1)).toBe("test:run:complete")
            expect(result.events.map(event => event.time.seq)).toEqual(result.events.map((_, index) => index))

            const failed = result.events.find(event => event.type === "test:case:fail")
            expect(failed?.data.error.message).toContain("Expected")
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    }, 20_000)

    it("uses stable case identities across separate executions", async () => {
        const { root, file } = await fixture(`
            describe("stable", () => {
                it("identity", () => expect(true).toBe(true))
            })
        `)

        try {
            const first = await TestRunner().run({ cwd: root, files: file })
            const second = await TestRunner().run({ cwd: root, files: file })
            const id = (events: typeof first.events) => events.find(event => event.type === "test:case:declare")?.context.testId

            expect(id(first.events)).toBe(id(second.events))
            expect(first.status).toBe("passed")
            expect(second.status).toBe("passed")
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    }, 20_000)

    it("redirects explicit bun:test imports through the same instrumentation facade", async () => {
        const { root, file } = await fixture(`
            import { describe, expect, it } from "bun:test"

            describe("imported", () => {
                it("still emits", () => expect(2 + 2).toBe(4))
            })
        `)

        try {
            const result = await TestRunner().run({ cwd: root, files: file })

            expect(result.status).toBe("passed")
            expect(result.events.some(event => event.type === "test:suite:declare")).toBe(true)
            expect(result.events.some(event => event.type === "test:case:pass")).toBe(true)
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    }, 20_000)

    it("preserves callback tests and emits a distinct attempt for each repeat", async () => {
        const { root, file } = await fixture(`
            it("callback", done => {
                setTimeout(() => done(), 1)
            }, { repeats: 1 })
        `)

        try {
            const result = await TestRunner().run({ cwd: root, files: file })
            const attempts = result.events
                .filter(event => event.type === "test:case:start")
                .map(event => event.context.attempt)

            expect(result.status).toBe("passed")
            expect(attempts).toEqual([0, 1])
            expect(result.events.filter(event => event.type === "test:case:pass")).toHaveLength(2)
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    }, 20_000)

    it("resolves globs deterministically and runs each file through an isolated child", async () => {
        const root = await mkdtemp(join(tmpdir(), "axon-test-runner-glob-"))
        await Bun.write(join(root, "b.test.ts"), `it("b", () => expect(true).toBe(true))`)
        await Bun.write(join(root, "a.test.ts"), `it("a", () => expect(true).toBe(true))`)

        try {
            const result = await TestRunner().run({ cwd: root, files: "*.test.ts" })

            expect(result.files).toEqual(["a.test.ts", "b.test.ts"])
            expect(result.events.filter(event => event.type === "test:file:start").map(event => event.context.file)).toEqual(result.files)
            expect(result.status).toBe("passed")
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    }, 20_000)

    it("records hook failures even when Bun never enters the test callback", async () => {
        const { root, file } = await fixture(`
            describe("hook failure", () => {
                beforeEach(() => { throw new Error("setup exploded") })
                it("never starts", () => {})
            })
        `)

        try {
            const result = await TestRunner().run({ cwd: root, files: file })
            const failure = result.events.find(event => event.type === "test:hook:fail")

            expect(result.status).toBe("failed")
            expect(failure?.data.error.message).toBe("setup exploded")
            expect(result.events.some(event => event.type === "test:case:start")).toBe(false)
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    }, 20_000)

    it("cancels the child and reconciles a started test without a terminal frame", async () => {
        const { root, file } = await fixture(`
            it("waits", async () => {
                await Bun.sleep(30_000)
            })
        `)
        const controller = new AbortController()

        try {
            const result = await TestRunner().run({
                cwd: root,
                files: file,
                signal: controller.signal,
                onEvent(event) {
                    if (event.type === "test:case:start") controller.abort()
                },
            })

            expect(result.status).toBe("cancelled")
            expect(result.events.some(event => event.type === "test:case:fail")).toBe(true)
            expect(result.events.at(-1)?.type).toBe("test:run:complete")
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    }, 20_000)
})
