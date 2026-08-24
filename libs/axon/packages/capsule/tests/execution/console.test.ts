import { Capsule } from "@axon/capsule"
import type { CapsuleEvent } from "@axon/capsule"

function collectConsoleEvents(capsule: ReturnType<typeof Capsule>) {
    const events: CapsuleEvent["capsule:console"][] = []
    capsule.on("capsule:console", e => events.push(e))
    return events
}

describe("Capsule console", () => {
    it("captures console.log as a capsule:console event, correlated to the run", async () => {
        const capsule = Capsule()
        const events = collectConsoleEvents(capsule)
        await capsule.boot()

        await capsule.run(`console.log("hello"); 1`)

        expect(events).toHaveLength(1)
        expect(events[0]?.level).toBe("log")
        expect(events[0]?.args).toEqual(["hello"])
        expect(typeof events[0]?.commandId).toBe("string")

        await capsule.shutdown()
    })

    it("captures every console level distinctly", async () => {
        const capsule = Capsule()
        const events = collectConsoleEvents(capsule)
        await capsule.boot()

        await capsule.run(`
            console.log("a")
            console.info("b")
            console.warn("c")
            console.error("d")
            console.debug("e")
        `)

        expect(events.map(e => e.level)).toEqual(["log", "info", "warn", "error", "debug"])

        await capsule.shutdown()
    })

    it("preserves multiple arguments, including non-string values", async () => {
        const capsule = Capsule()
        const events = collectConsoleEvents(capsule)
        await capsule.boot()

        await capsule.run(`console.log("count:", 42, { ok: true })`)

        expect(events[0]?.args).toEqual(["count:", 42, { ok: true }])

        await capsule.shutdown()
    })

    it("attributes console output to the correct run when two runs are concurrent", async () => {
        const capsule = Capsule()
        const events = collectConsoleEvents(capsule)
        await capsule.boot()

        const [a, b] = await Promise.all([
            capsule.run(`console.log("from-a"); await new Promise(r => setTimeout(r, 20)); "a"`),
            capsule.run(`console.log("from-b"); "b"`),
        ])

        expect(a).toBe("a")
        expect(b).toBe("b")

        const fromA = events.find(e => e.args[0] === "from-a")
        const fromB = events.find(e => e.args[0] === "from-b")
        expect(fromA?.commandId).not.toBe(fromB?.commandId)

        await capsule.shutdown()
    })

    it("never leaks console output onto the raw stdout wire", async () => {
        // If console interception were broken, a plain string line on stdout
        // would either corrupt the JSONL stream or get silently swallowed by
        // Wire's multi-line recovery buffer — either way run() would still
        // resolve normally while quietly losing the console call. Asserting
        // the event was captured is the only reliable signal that it went
        // through the protocol, not around it.
        const capsule = Capsule()
        const events = collectConsoleEvents(capsule)
        const parseErrors: unknown[] = []
        capsule.on("capsule:parse:error", e => parseErrors.push(e))
        await capsule.boot()

        const result = await capsule.run(`console.log("must not corrupt the wire"); "done"`)

        expect(result).toBe("done")
        expect(parseErrors).toHaveLength(0)
        expect(events).toHaveLength(1)

        await capsule.shutdown()
    })

    it("captures process.stdout.write without corrupting the command-complete frame", async () => {
        const capsule = Capsule()
        const events = collectConsoleEvents(capsule)
        const parseErrors: unknown[] = []
        capsule.on("capsule:parse:error", e => parseErrors.push(e))
        await capsule.boot()

        // No newline is deliberate: this previously glued raw JSON directly
        // onto capsule:cmd:complete and left the host waiting forever.
        const result = await capsule.run(`process.stdout.write(JSON.stringify({ ok: true }))`)

        expect(result).toBe(true)
        expect(events.map(e => e.args[0])).toEqual(['{"ok":true}'])
        expect(parseErrors).toHaveLength(0)
        expect(await capsule.run("21 * 2")).toBe(42)

        await capsule.shutdown()
    })
})
