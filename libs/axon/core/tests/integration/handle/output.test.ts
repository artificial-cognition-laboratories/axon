import { Axon } from "../../setup/axon"
import { Mock } from "@arcforge/engines"
import { run } from "@arcforge/engines/mock"

/**
 * Structured output's pre-flight, through the real handle.
 *
 * The contract this proves: an `output` type is checked BEFORE the model is
 * called. A bad type throws at the caller's own line, having spent no
 * inference — which is what makes `output` a guarantee rather than a hint,
 * and what turns a typo into a synchronous error instead of a confusing
 * repair loop three model calls deep.
 *
 * The checker itself is covered exhaustively in
 * packages/air/tests/output.test.ts — pre-flight, enforcement and the
 * soundness holes (`as`, `satisfies`, `any`). What is proven HERE is the
 * loop those pieces form once a real engine is attached: a violating script
 * costs another model call, a satisfied one runs, and an exhausted budget
 * throws rather than returning something unchecked.
 */
describe("Structured output", () => {
    it("rejects a malformed output type without calling the model", async () => {
        let calls = 0
        const runtime = await Axon({
            blueprint: { config: { providers: [Mock(() => { calls++; return "hi" })] } },
        })

        await expect(
            runtime.axon.request({ prompt: "anything", output: "{ files: number" })
        ).rejects.toThrow()

        // The whole point: no inference was spent on a request that could
        // never have been satisfied.
        expect(calls).toBe(0)

        await runtime.shutdown()
    })

    it("rejects an output type naming something that does not exist", async () => {
        const runtime = await Axon({ blueprint: { config: { providers: [Mock({ hello: "hi" })] } } })

        await expect(
            runtime.axon.request({ prompt: "x", output: "{ issues: NoSuchType[] }" })
        ).rejects.toThrow()

        await runtime.shutdown()
    })

    it("accepts a valid output type and runs the request", async () => {
        const runtime = await Axon({ blueprint: { config: { providers: [Mock({ hello: "hi there" })] } } })

        const result = await runtime.axon.request({
            prompt: "hello",
            output: "{ files: number }",
        })
        expect(result.entries.length).toBeGreaterThan(0)

        await runtime.shutdown()
    })

    it("accepts the declaration form for a shared shape", async () => {
        const runtime = await Axon({ blueprint: { config: { providers: [Mock({ hello: "hi" })] } } })

        await expect(
            runtime.axon.request({
                prompt: "hello",
                output: "type Issue = { file: string }\ntype Output = { issues: Issue[] }",
            })
        ).resolves.toBeDefined()

        await runtime.shutdown()
    })

    // A contract belongs to ONE invocation. If it outlived its wake, the
    // next request would be silently held to a shape nobody asked for.
    it("does not leak a contract into a later request", async () => {
        const runtime = await Axon({ blueprint: { config: { providers: [Mock({ hello: "hi" })] } } })

        await runtime.axon.request({ prompt: "hello", output: "{ files: number }" })
        await expect(runtime.axon.request({ prompt: "hello" })).resolves.toBeDefined()

        await runtime.shutdown()
    })

    it("leaves requests with no output type completely unaffected", async () => {
        const runtime = await Axon({ blueprint: { config: { providers: [Mock({ hello: "hi there" })] } } })

        const result = await runtime.axon.request({ prompt: "hello" })
        expect(result.text).toContain("hi")

        await runtime.shutdown()
    })
    it("runs a script that satisfies the type", async () => {
        const runtime = await Axon({ blueprint: { config: { providers: [Mock({
            audit: [run("const result = { files: 3 }"), "done"],
        })] } } })

        const result = await runtime.axon.request({
            prompt: "audit",
            output: "{ files: number }",
        })
        // The script reached the capsule and its result came back, which is
        // only true if the contract check passed before it was reported.
        expect(result.entries.some(e => e.type === "cognet:action:result")).toBe(true)

        await runtime.shutdown()
    })

    /**
     * The loop's whole point: a wrong shape costs another model call rather
     * than reaching the caller. `retries: 1` means exactly two attempts, so
     * the count is an assertion about the budget, not an approximation.
     */
    it("retries a violating script and throws once the budget is spent", async () => {
        let calls = 0
        const runtime = await Axon({ blueprint: { config: { providers: [Mock(() => {
            calls++
            return { steps: [run("const result = { files: 'not-a-number' }")] } as never
        })] } } })

        await expect(
            runtime.axon.request({ prompt: "audit", output: "{ files: number }", retries: 1 }),
        ).rejects.toMatchObject({ code: "AX-OUTPUT-002" })
        expect(calls).toBe(2)

        await runtime.shutdown()
    })

    /**
     * A failed attempt must leave nothing behind. The script is checked
     * BEFORE it is reported, so a contract-violating script never reaches
     * the capsule — otherwise every retry would double its side effects.
     */
    it("never runs a script that failed its contract", async () => {
        const runtime = await Axon({ blueprint: { config: { providers: [Mock(() => ({
            steps: [run("const result = { files: 'not-a-number' }")],
        }) as never)] } } })

        await expect(
            runtime.axon.request({ prompt: "audit", output: "{ files: number }", retries: 0 }),
        ).rejects.toMatchObject({ code: "AX-OUTPUT-002" })

        const ran = runtime.session.entries.some(e => e.type === "cognet:action:result")
        expect(ran).toBe(false)

        await runtime.shutdown()
    })

    /**
     * `request()` is `stream()` drained (see Kernel.streamWithContract), so
     * a contract cannot be installed for one and skipped for the other. The
     * failure surfaces as a throw at the consumer, not a silently short
     * stream.
     */
    it("enforces the same contract on stream()", async () => {
        let calls = 0
        const runtime = await Axon({ blueprint: { config: { providers: [Mock(() => {
            calls++
            return { steps: [run("const result = { files: 'nope' }")] } as never
        })] } } })

        const run_ = runtime.axon.stream({ prompt: "audit", output: "{ files: number }", retries: 1 })
        await expect((async () => {
            for await (const _ of run_.stream) { /* drain */ }
        })()).rejects.toMatchObject({ code: "AX-OUTPUT-002" })
        expect(calls).toBe(2)

        await runtime.shutdown()
    })
})
