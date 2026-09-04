import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Schedule } from "../../src/schedule/schedule"

const roots: string[] = []
afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function store() {
    const root = await mkdtemp(join(tmpdir(), "axond-schedule-"))
    roots.push(root)
    return { root, schedule: Schedule({ root }) }
}

const base = {
    agent: "@test/agent",
    projectRoot: "/tmp/agent",
    every: "0 9 * * 1-5",
    args: {},
}

describe("schedule persistence", () => {
    test("accepts prompt-only, script-only, and combined targets", async () => {
        const { schedule } = await store()
        const prompt = schedule.create({ ...base, prompt: "review", script: null })
        const script = schedule.create({ ...base, prompt: null, script: "audit" })
        const both = schedule.create({ ...base, prompt: "review", script: "audit" })

        expect(schedule.list()).toHaveLength(3)
        expect(prompt.prompt).toBe("review")
        expect(script.script).toBe("audit")
        expect(both.prompt).toBe("review")
        expect(both.script).toBe("audit")
    })

    test("persists atomically and reloads from disk", async () => {
        const { root, schedule } = await store()
        const created = schedule.create({ ...base, prompt: null, script: "a", paused: true })

        const restored = Schedule({ root })
        expect(restored.list()).toEqual([created])
        expect(await readFile(join(root, "schedules", created.id + ".json"), "utf8")).toContain('"script": "a"')
    })

    test("rejects a schedule with neither target", async () => {
        const { schedule } = await store()
        expect(() => schedule.create({ ...base, prompt: null, script: null })).toThrow(/prompt or script/)
    })

    test("updates and removes a schedule", async () => {
        const { schedule } = await store()
        const created = schedule.create({ ...base, prompt: "review", script: null })
        const updated = schedule.update(created.id, { prompt: null, script: "a" })

        expect(updated.prompt).toBeNull()
        expect(updated.script).toBe("a")
        expect(schedule.remove(created.id)).toBe(true)
        expect(schedule.list()).toEqual([])
    })
})
