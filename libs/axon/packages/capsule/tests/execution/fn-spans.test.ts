import { Capsule } from "@axon/capsule"
import type { CapsuleEvent } from "@axon/capsule"
import { join } from "path"

const FIXTURES = join(import.meta.dir, "fixtures")
const mathScope = {
    name: "math",
    members: [{ name: "add", declaration: "function add(): unknown" }],
}

type FnStart = CapsuleEvent["capsule:fn:start"]
type FnComplete = CapsuleEvent["capsule:fn:complete"]
type FnFailed = CapsuleEvent["capsule:fn:failed"]

/**
 * capsule:fn:* is the tool-call span — the record of every mediated call a
 * command made. It is emitted from the scope wrapper, the one enforcement
 * point every tool call funnels through, so a tool cannot opt out of being
 * observed.
 */
describe("Capsule fn spans", () => {
    it("brackets a successful tool call with start and complete, correlated to the command", async () => {
        const capsule = Capsule({
            tools: [{ namespace: "math", scope: mathScope, path: join(FIXTURES, "math.ts") }],
            policy: { tools: { math: true } },
        })
        const starts: FnStart[] = []
        const completes: FnComplete[] = []
        capsule.on("capsule:fn:start", e => starts.push(e))
        capsule.on("capsule:fn:complete", e => completes.push(e))
        await capsule.boot()

        const result = await capsule.run("math.add(1, 2)")
        expect(result).toBe(3)

        expect(starts).toHaveLength(1)
        expect(starts[0]?.fn).toBe("math.add")
        expect(starts[0]?.module).toBe("math")
        expect(starts[0]?.args).toEqual([1, 2])

        expect(completes).toHaveLength(1)
        expect(completes[0]?.fn).toBe("math.add")
        expect(completes[0]?.result).toBe(3)
        expect(completes[0]?.durationMs).toBeGreaterThanOrEqual(0)

        // both halves attribute to the same command — this is what lets a
        // reader join a tool call to the code block that made it
        expect(starts[0]?.commandId).toBeTruthy()
        expect(completes[0]?.commandId).toBe(starts[0]!.commandId)

        await capsule.shutdown()
    })

    it("emits failed, not complete, when the tool throws — and still propagates the throw", async () => {
        const source = `
            export default {
                name: "boom",
                exports: { explode: () => { throw new Error("kaboom") } },
            }
        `
        const capsule = Capsule({
            tools: [{ namespace: "boom", scope: { name: "boom", members: [{ name: "explode", declaration: "function explode(): unknown" }] }, source }],
            policy: { tools: { boom: true } },
        })
        const completes: FnComplete[] = []
        const failures: FnFailed[] = []
        capsule.on("capsule:fn:complete", e => completes.push(e))
        capsule.on("capsule:fn:failed", e => failures.push(e))
        await capsule.boot()

        await expect(capsule.run("boom.explode()")).rejects.toThrow()

        expect(completes).toHaveLength(0)
        expect(failures).toHaveLength(1)
        expect(failures[0]?.fn).toBe("boom.explode")

        // The structured error crosses the pipe intact — the tool's own
        // message, plus the code a reader joins on.
        expect(failures[0]?.error.isAxonError).toBe(true)
        expect(failures[0]?.error.code).toBe("AX-CAPSULE-019")
        expect(failures[0]?.error.message).toContain("kaboom")

        await capsule.shutdown()
    })

    it("does not open a span for a call policy denied — a denial is not an execution", async () => {
        const capsule = Capsule({
            tools: [{ namespace: "math", scope: mathScope, path: join(FIXTURES, "math.ts") }],
            policy: { tools: { math: false } },
        })
        const starts: FnStart[] = []
        const denials: CapsuleEvent["capsule:policy:denied"][] = []
        capsule.on("capsule:fn:start", e => starts.push(e))
        capsule.on("capsule:policy:denied", e => denials.push(e))
        await capsule.boot()

        await expect(capsule.run("math.add(1, 2)")).rejects.toThrow()

        // the denial is recorded, but no bracket was opened — an unpaired
        // :start would hang open in every flame graph forever
        expect(denials).toHaveLength(1)
        expect(starts).toHaveLength(0)

        await capsule.shutdown()
    })

    it("brackets every call when a command makes several", async () => {
        const capsule = Capsule({
            tools: [{ namespace: "math", scope: mathScope, path: join(FIXTURES, "math.ts") }],
            policy: { tools: { math: true } },
        })
        const completes: FnComplete[] = []
        capsule.on("capsule:fn:complete", e => completes.push(e))
        await capsule.boot()

        // Mediated calls are always async — policy may escalate to the host
        // before a call is admitted — so tool calls are awaited, as agent
        // code must do.
        const result = await capsule.run("(await math.add(1, 2)) + (await math.add(3, 4))")
        expect(result).toBe(10)

        expect(completes).toHaveLength(2)
        expect(completes.map(e => e.result)).toEqual([3, 7])

        await capsule.shutdown()
    })
})
