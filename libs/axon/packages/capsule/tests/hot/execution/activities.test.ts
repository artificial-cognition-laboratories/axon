import { Capsule } from "@arcforge/capsule"
import type { CapsuleEvent } from "@arcforge/capsule"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

function collectActivityEvents(capsule: ReturnType<typeof Capsule>) {
    const events: CapsuleEvent["process:activity"][] = []
    capsule.on("process:activity", e => events.push(e))
    return events
}

describe("Capsule activities", () => {
    it("emits a semantic activity around process.run() without tool author cooperation", async () => {
        const capsule = Capsule({ policy: { shell: { allow: ["echo"] } } })
        const events = collectActivityEvents(capsule)
        await capsule.boot()

        await capsule.run(`await process.run("echo hello")`)

        expect(events.map(event => event.activity)).toEqual(["proc:exec", "proc:exec"])
        expect(events.map(event => event.phase)).toEqual(["declared", "done"])
        expect(events[0]?.data).toMatchObject({ command: "echo hello", startedAt: expect.any(Number) })
        expect(events.at(-1)?.data).toMatchObject({ outputBytes: 6, exitCode: 0 })
        await capsule.shutdown()
    })

    it("emits directory changes immediately from process.chdir()", async () => {
        const target = mkdtempSync(join(tmpdir(), "axon-activity-cwd-"))
        const capsule = Capsule()
        const events = collectActivityEvents(capsule)
        await capsule.boot()

        try {
            await capsule.run(`process.chdir(${JSON.stringify(target)})`)

            expect(events.map(event => event.activity)).toEqual(["process:chdir", "process:chdir"])
            expect(events.map(event => event.phase)).toEqual(["declared", "done"])
            expect(events[0]?.data).toEqual({ cwd: target })
        } finally {
            await capsule.shutdown()
            rmSync(target, { recursive: true, force: true })
        }
    })

    it("marks a nonzero shell exit as a failed activity", async () => {
        const capsule = Capsule({ policy: { shell: { allow: ["false"] } } })
        const events = collectActivityEvents(capsule)
        await capsule.boot()
        try {
            await capsule.run(`await process.run("false")`)
            expect(events.map(event => event.phase)).toEqual(["declared", "failed"])
            expect(events.at(-1)?.data).toMatchObject({ exitCode: 1 })
            expect(events.at(-1)?.error).toBe("exit 1")
        } finally {
            await capsule.shutdown()
        }
    })

    it("reports bounded output progress before a long command exits", async () => {
        const capsule = Capsule({ policy: { shell: { allow: ["node"] } } })
        const events = collectActivityEvents(capsule)
        await capsule.boot()
        try {
            const command = `node -e 'process.stdout.write("a"); setTimeout(() => process.stdout.write("b"), 1100)'`
            await capsule.run(`await process.run(${JSON.stringify(command)})`)
            expect(events.map(event => event.phase)).toEqual(["declared", "declared", "done"])
            expect(events[1]?.data).toMatchObject({ outputBytes: 2 })
            expect(events[2]?.data).toMatchObject({ outputBytes: 2 })
        } finally {
            await capsule.shutdown()
        }
    })

    it("tracks a spawned process through start and an explicit kill", async () => {
        const capsule = Capsule({ policy: { shell: { allow: ["sleep"], spawn: true } } })
        const events = collectActivityEvents(capsule)
        await capsule.boot()

        await capsule.run(`
            const proc = process.spawn("sleep 30")
            await proc.started
        `)

        // The creating script has completed, but the child has not. That is
        // the exact state the TUI must render as still-live.
        expect(events.map(event => event.phase)).toEqual(["declared", "declared"])
        expect(events[1]?.data).toMatchObject({ pid: expect.any(Number) })
        expect(capsule.process.list()).toHaveLength(1)

        const child = capsule.process.list()[0]!
        child.kill()
        await child.exited

        // `spawn` declares once, then announces its real pid while it remains
        // open. It settles only after the managed child exits.
        expect(events.map(event => event.activity)).toEqual(["proc:spawn", "proc:spawn", "proc:kill", "proc:kill", "proc:spawn"])
        expect(events.map(event => event.phase)).toEqual(["declared", "declared", "declared", "done", "done"])
        await capsule.shutdown()
    })

    it("marks a refused spawn as failed after its creating script has returned", async () => {
        const capsule = Capsule()
        const events = collectActivityEvents(capsule)
        await capsule.boot()

        await capsule.run(`await process.spawn("sleep 30").started`)

        expect(events.map(event => event.phase)).toEqual(["declared", "failed"])
        expect(events[1]?.error).toContain("denied")
        await capsule.shutdown()
    })

    it("emits declared then done for an explicit activity lifecycle, correlated to the run", async () => {
        const capsule = Capsule()
        const events = collectActivityEvents(capsule)
        await capsule.boot()

        await capsule.run(`
            const act = axon.activity("file:patch", { path: "src/config.ts" })
            act.done({ diff: "- a\\n+ b" })
            "ok"
        `)

        expect(events).toHaveLength(2)
        expect(events[0]?.phase).toBe("declared")
        expect(events[0]?.activity).toBe("file:patch")
        expect(events[0]?.data).toEqual({ path: "src/config.ts" })
        expect(events[1]?.phase).toBe("done")
        expect(events[1]?.data).toEqual({ diff: "- a\n+ b" })
        expect(events[1]?.id).toBe(events[0]?.id ?? "")
        expect(typeof events[0]?.commandId).toBe("string")

        await capsule.shutdown()
    })

    it("auto-settles an unclosed activity as done when the command completes", async () => {
        const capsule = Capsule()
        const events = collectActivityEvents(capsule)
        await capsule.boot()

        await capsule.run(`axon.activity("file:read", { path: "a.txt" }); 1`)

        expect(events.map(e => e.phase)).toEqual(["declared", "done"])

        await capsule.shutdown()
    })

    it("auto-settles an open activity as failed when the script throws", async () => {
        const capsule = Capsule()
        const events = collectActivityEvents(capsule)
        await capsule.boot()

        await expect(
            capsule.run(`axon.activity("file:write", { path: "b.txt" }); throw new Error("boom")`),
        ).rejects.toThrow("boom")

        expect(events.map(e => e.phase)).toEqual(["declared", "failed"])
        expect(events[1]?.error).toBe("boom")

        await capsule.shutdown()
    })

    it("done() is idempotent — auto-settle never double-fires", async () => {
        const capsule = Capsule()
        const events = collectActivityEvents(capsule)
        await capsule.boot()

        await capsule.run(`
            const act = axon.activity("note", { text: "once" })
            act.done()
            act.done()
            "ok"
        `)

        expect(events).toHaveLength(2)

        await capsule.shutdown()
    })

    it("uses a caller-supplied command id, so activities correlate to the caller's own span", async () => {
        const capsule = Capsule()
        const events = collectActivityEvents(capsule)
        await capsule.boot()

        await capsule.run(`axon.activity("note", { text: "hi" }); 1`, { id: "my-entry-id" })

        expect(events).toHaveLength(2)
        expect(events.every(e => e.commandId === "my-entry-id")).toBe(true)

        await capsule.shutdown()
    })

    it("attributes concurrent runs' activities to their own commandIds", async () => {
        const capsule = Capsule()
        const events = collectActivityEvents(capsule)
        await capsule.boot()

        await Promise.all([
            capsule.run(`axon.activity("note", { text: "from-a" }); await new Promise(r => setTimeout(r, 20)); "a"`),
            capsule.run(`axon.activity("note", { text: "from-b" }); "b"`),
        ])

        const fromA = events.find(e => e.phase === "declared" && e.activity === "note" && e.data.text === "from-a")
        const fromB = events.find(e => e.phase === "declared" && e.activity === "note" && e.data.text === "from-b")
        expect(fromA?.commandId).not.toBe(fromB?.commandId)

        await capsule.shutdown()
    })
})
