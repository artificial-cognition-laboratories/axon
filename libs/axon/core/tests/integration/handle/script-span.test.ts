import { writeFile, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Axon } from "../../setup/axon"
import { Mock } from "@arcforge/engines"

/**
 * A script run is a SPAN on the durable record.
 *
 * Scripts were invisible: one drove the agent, its wakes landed in the log,
 * and nothing said which script caused them or how long the whole job took.
 * A surface could show the turns and never the reason for them.
 *
 * The bracket is also what gives a flame graph its interior. Nesting there is
 * recovered by bracket-matching in seq order — not parent pointers (see
 * span.ts) — and roots are discovered by POSITION, so `axon:script:start`
 * opens at depth 0 and everything the script causes nests inside it with no
 * change to Fleet at all. Without the span, a script run is one opaque bar.
 */

async function withScript<T>(body: string, run: (name: string, dir: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(path.join(tmpdir(), "axon-script-span-"))
    const filePath = path.join(dir, "job.ts")
    await writeFile(filePath, body)
    try {
        return await run(filePath, dir)
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
}

const types = (runtime: { session: { log: readonly { type: string }[] } }): string[] =>
    runtime.session.log.map(e => e.type).filter(t => t.startsWith("axon:script"))

describe("axon:script span", () => {
    it("brackets a successful run", async () => {
        await withScript(`const x = 1\n`, async filePath => {
            const runtime = await Axon({ blueprint: { scripts: [{ name: "job", filePath }] } })
            await runtime.axon.scripts.request("job")

            expect(types(runtime)).toEqual(["axon:script:start", "axon:script:complete"])
            await runtime.shutdown()
        })
    }, 30_000)

    it("carries the name and args on the opening half", async () => {
        await withScript(`const x = 1\n`, async filePath => {
            const runtime = await Axon({ blueprint: { scripts: [{ name: "job", filePath }] } })
            await runtime.axon.scripts.request("job", { target: "src/" })

            const start = runtime.session.log.find(e => e.type === "axon:script:start")
            expect((start!.data as { name: string }).name).toBe("job")
            expect((start!.data as { args: Record<string, unknown> }).args).toEqual({ target: "src/" })
            await runtime.shutdown()
        })
    }, 30_000)

    it("closes the bracket when the script throws", async () => {
        // Opened BEFORE the import, deliberately: a script that dies on its
        // first line still ran, and a bracket that only opened on success
        // would leave the failure outside any span — unpaired for anything
        // counting depth, and invisible to a reader asking what was started.
        await withScript(`throw new Error("boom")\n`, async filePath => {
            const runtime = await Axon({ blueprint: { scripts: [{ name: "job", filePath }] } })
            await expect(runtime.axon.scripts.request("job")).rejects.toThrow()

            expect(types(runtime)).toEqual(["axon:script:start", "axon:script:failed"])
            await runtime.shutdown()
        })
    }, 30_000)

    it("records what the script printed, in order", async () => {
        // Scripts talk through console — every script in the registry is
        // written to it. Captured at the runner rather than relying on the
        // capsule's redirect, which only applies while a COMMAND is executing:
        // true when the TUI runs a script, false for a direct request. The
        // direct path wrote to real stdout and emitted nothing at all.
        await withScript(`console.log("phase one")\nconsole.error("uh oh")\n`, async filePath => {
            const runtime = await Axon({ blueprint: { scripts: [{ name: "job", filePath }] } })
            await runtime.axon.scripts.request("job")

            const logs = runtime.session.log.filter(e => e.type === "axon:script:log")
            expect(logs.map(e => (e.data as { content: string }).content)).toEqual(["phase one", "uh oh"])
            expect(logs.map(e => (e.data as { level: string }).level)).toEqual(["log", "error"])
            await runtime.shutdown()
        })
    }, 30_000)

    it("restores console when the script is done", async () => {
        // The capture is scoped to the run. Leaving it installed would route
        // the HOST's own logging into a session that had already finished.
        await withScript(`console.log("inside")\n`, async filePath => {
            const runtime = await Axon({ blueprint: { scripts: [{ name: "job", filePath }] } })
            await runtime.axon.scripts.request("job")

            const before = runtime.session.log.length
            console.log("outside")
            expect(runtime.session.log.length).toBe(before)
            await runtime.shutdown()
        })
    }, 30_000)

    it("nests the wakes a script triggers inside its own bracket", async () => {
        // The property the flame graph depends on: containment in seq order.
        // Everything between :start and :complete belongs to the script.
        await withScript(`await axon.request("hi")\n`, async filePath => {
            const runtime = await Axon({
                blueprint: {
                    scripts: [{ name: "job", filePath }],
                    config: { providers: [Mock({ hi: "hello" })] },
                },
            })
            await runtime.axon.scripts.request("job")

            const all = [...runtime.session.log, ...runtime.session.entries]
                .sort((a, b) => a.time.seq - b.time.seq)
            const open = all.findIndex(e => e.type === "axon:script:start")
            const close = all.findIndex(e => e.type === "axon:script:complete")

            expect(open).toBeGreaterThanOrEqual(0)
            expect(close).toBeGreaterThan(open)
            // The stimulus the script raised sits BETWEEN the brackets.
            const stimulus = all.findIndex(e => e.type === "cognet:stimulus:text")
            expect(stimulus).toBeGreaterThan(open)
            expect(stimulus).toBeLessThan(close)

            await runtime.shutdown()
        })
    }, 30_000)

    it("records a cancelled script as interrupted, never as failed", async () => {
        // An interrupt is a SETTLED OUTCOME. The user stopped it and it did
        // what it was told; rendering that red would blame them for their own
        // decision, which is why the ontology has a fourth state at all.
        //
        // Read off the ORIGINAL cause rather than the wrapped error — `err()`
        // returns its own AxonError, so checking `failure.name` recorded every
        // abort as `:failed`. Caught by running it rather than by reading it.
        await withScript(`const e = new Error("stopped"); e.name = "AbortError"; throw e\n`, async filePath => {
            const runtime = await Axon({ blueprint: { scripts: [{ name: "job", filePath }] } })
            await expect(runtime.axon.scripts.request("job")).rejects.toThrow()

            expect(types(runtime)).toEqual(["axon:script:start", "axon:script:interrupted"])
            await runtime.shutdown()
        })
    }, 30_000)
})
