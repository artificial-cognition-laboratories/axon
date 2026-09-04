import { err, isAxonError, type AxonError } from "../src/err"
import { errScope } from "../src/sink"
import { describe, it, expect } from "bun:test"

describe("err()", () => {
    it("is a real Error — throwable, catchable, instanceof Error", () => {
        expect(() => {
            throw err("ENGINE_MISSING")
        }).toThrow()

        try {
            throw err("ENGINE_MISSING")
        } catch (e) {
            expect(e).toBeInstanceOf(Error)
            expect(isAxonError(e)).toBe(true)
        }
    })

    it("carries the map's identity fields onto the constructed error", () => {
        const e = err("ENGINE_MISSING")

        expect(e.code).toBe("AX-ENGINE-001")
        expect(e.title).toBe("No Engine Configured")
        expect(e.description).toContain("engine")
        expect(e.source).toBe("runtime")
        expect(e.severity).toBe("fatal")
    })

    it("accepts free-form context and preserves it", () => {
        const e = err("PROMPT_NOT_FOUND", { context: { name: "greeting", available: ["a", "b"] } })

        expect(e.context).toEqual({ name: "greeting", available: ["a", "b"] })
    })

    it("severity can be overridden per call site", () => {
        const e = err("PROMPT_NOT_FOUND", { severity: "degraded" })

        expect(e.severity).toBe("degraded")
    })

    it("captures a cause and it is walkable via Error.cause", () => {
        const original = new Error("disk read failed")
        const e = err("PROMPT_FILE_NOT_FOUND", { cause: original })

        expect(e.cause).toBe(original)
    })

    it("captures real stack frames pointing at the call site, not err()'s own internals", () => {
        const e = err("ENGINE_MISSING")

        expect(e.frames.length).toBeGreaterThan(0)
        expect(e.frames[0]?.fileName).toContain("throws.test.ts")
        expect(e.frames.some(f => f.fileName?.includes("err/err.ts"))).toBe(false)
    })

    it("toJSON() produces the full plain-data report — no compact wire projection", () => {
        const e = err("ENGINE_MISSING")
        const json = e.toJSON()

        expect(json.isAxonError).toBe(true)
        expect(json.code).toBe(e.code)
        expect(json.title).toBe(e.title)
        expect(json.description).toBe(e.description)
        expect(json.message).toBe(e.message)
        expect(json.severity).toBe(e.severity)
        expect(json.frames).toBe(e.frames)
    })

    it("toJSON() carries context along", () => {
        const e = err("PROMPT_NOT_FOUND", { context: { name: "greeting" } })

        expect(e.toJSON().context).toEqual({ name: "greeting" })
    })

    it("toJSON() never throws on a circular context — degrades to a string instead", () => {
        const circular: Record<string, unknown> = { name: "greeting" }
        circular.self = circular
        const e = err("PROMPT_NOT_FOUND", { context: circular })

        expect(() => e.toJSON()).not.toThrow()
        expect(e.toJSON().context).toEqual({ unserializable: expect.any(String) })
    })

    it("JSON.stringify calls toJSON() automatically — an AxonError serializes correctly with no explicit call", () => {
        const e = err("ENGINE_MISSING")
        const parsed = JSON.parse(JSON.stringify(e))

        expect(parsed.isAxonError).toBe(true)
        expect(parsed.code).toBe(e.code)
    })

    it("toJSON() captures the cause as plain data, not the raw value", () => {
        const original = new Error("disk read failed")
        const e = err("PROMPT_FILE_NOT_FOUND", { cause: original })

        const cause = e.toJSON().cause as { message: string; stack?: string; frame?: unknown }
        expect(cause.message).toBe("disk read failed")
        expect(cause.stack).toBe(original.stack)
        // frame is the cause's own first non-framework stack frame — where
        // the user's code actually threw; presence is the contract here.
        expect(cause.frame).toBeDefined()
    })
})

describe("err(cause) — the unknown-catch form", () => {
    it("passes an existing AxonError through untouched", () => {
        const original = err("ENGINE_MISSING")
        expect(err(original)).toBe(original)
    })

    it("wraps a plain Error as an unclassified fatal, preserving its message and stack", () => {
        const plain = new Error("something broke")
        const wrapped = err(plain)

        expect(isAxonError(wrapped)).toBe(true)
        expect(wrapped.code).toBe("AX-UNKNOWN-001")
        expect(wrapped.severity).toBe("fatal")
        expect(wrapped.message).toBe("something broke")
        expect(wrapped.stack).toBe(plain.stack)
        expect(wrapped.cause).toBe(plain)
    })

    it("wraps a thrown non-Error value", () => {
        const wrapped = err("just a string")

        expect(isAxonError(wrapped)).toBe(true)
        expect(wrapped.message).toBe("just a string")
    })
})

describe("errScope — AsyncLocalStorage error attribution", () => {
    it("delivers err() constructed inside the scope to that scope's sink", () => {
        const seen: AxonError[] = []
        const e = errScope.run(error => seen.push(error), () => err("ENGINE_MISSING"))

        expect(seen).toHaveLength(1)
        expect(seen[0]).toBe(e)
    })

    it("delivers through awaits — the scope survives async continuations", async () => {
        const seen: AxonError[] = []
        await errScope.run(error => seen.push(error), async () => {
            await Bun.sleep(1)
            err("ENGINE_MISSING")
        })

        expect(seen).toHaveLength(1)
    })

    it("is a no-op outside any scope — construction still succeeds, nothing is delivered", () => {
        const e = err("ENGINE_MISSING")
        expect(e.code).toBe("AX-ENGINE-001")
    })

    it("attributes to the innermost scope — two runtimes in one process never cross", async () => {
        const a: AxonError[] = []
        const b: AxonError[] = []

        await Promise.all([
            errScope.run(error => a.push(error), async () => {
                await Bun.sleep(2)
                err("ENGINE_MISSING")
            }),
            errScope.run(error => b.push(error), async () => {
                await Bun.sleep(1)
                err("PROMPT_NOT_FOUND", { context: { name: "x" } })
            }),
        ])

        expect(a).toHaveLength(1)
        expect(a[0]?.code).toBe("AX-ENGINE-001")
        expect(b).toHaveLength(1)
        expect(b[0]?.code).toBe("AX-PROMPT-001")
    })

    it("does not deliver twice when an existing AxonError is passed through err(existing)", () => {
        const seen: AxonError[] = []
        errScope.run(error => seen.push(error), () => {
            const original = err("ENGINE_MISSING")
            const passthrough = err(original)
            expect(passthrough).toBe(original)
        })

        expect(seen).toHaveLength(1)
    })
})
