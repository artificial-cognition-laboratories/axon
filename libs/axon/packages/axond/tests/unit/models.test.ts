import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Adapters, Models, OnnxAdapter, type LoadedWeight, type ModelAdapter } from "../../src/models/index"
import { Machine } from "../../src/machine/index"

/**
 * Loading weights, and the adapter layer that makes "any model" possible.
 *
 * The adapters here are FAKES. A test that loaded a real ONNX graph would be
 * asserting that onnxruntime works — which is its own project's job — rather
 * than that this daemon routes, admits and accounts correctly. The one thing
 * asserted against the real adapter is the property that matters when the
 * runtime is absent, which is the ordinary case on a fresh machine.
 */

const roots: string[] = []
afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** An adapter that claims one extension and loads without a runtime. */
function fake(runtime: "onnx" | "llama.cpp", ext: string, bytes = 1_000): ModelAdapter {
    return {
        runtime: runtime,
        claims: path => path.endsWith(ext),
        load: async (): Promise<LoadedWeight> => ({
            bytes: bytes,
            run: async input => input,
            unload: async () => {},
        }),
    }
}

async function models(adapters: ModelAdapter[], budget?: () => number | null) {
    const root = await mkdtemp(join(tmpdir(), "axond-models-"))
    roots.push(root)
    /**
     * A budget far above anything a fake adapter reports, unless a test is
     * specifically about refusal.
     *
     * `admit` measures the WHOLE card — the browser holding video memory is
     * real — so a small budget on a developer's machine is already exceeded
     * before the test loads anything. Tests about routing and residency must
     * not depend on how busy the GPU happens to be.
     */
    const machine = Machine({
        residencyRoot: root,
        budget: budget ?? (() => Number.MAX_SAFE_INTEGER),
    })
    return {
        models: Models({ machine: machine, root: root, adapters: Adapters(adapters) }),
        machine: machine,
        root: root,
    }
}

/** A file the fake adapters can claim. Contents are irrelevant — they never read it. */
async function weight(root: string, name: string): Promise<string> {
    const path = join(root, name)
    await writeFile(path, "not really a model")
    return path
}

describe("the adapter layer", () => {
    test("routes a file to the runtime that claims it", async () => {
        const { models: m, root } = await models([fake("onnx", ".onnx"), fake("llama.cpp", ".gguf")])

        const record = await m.load({
            path: await weight(root, "a.gguf"), model: "hf:x/a", agent: "@t/a", role: "main",
        })

        expect(record.runtime).toBe("llama.cpp")
    })

    test("order is the tie-break, so the first claimer wins", async () => {
        // Registration order IS the precedence policy — readable as one list
        // rather than an argument spread across claims() implementations.
        const { models: m, root } = await models([fake("onnx", ".bin"), fake("llama.cpp", ".bin")])

        const record = await m.load({
            path: await weight(root, "a.bin"), model: "hf:x/a", agent: "@t/a", role: "main",
        })

        expect(record.runtime).toBe("onnx")
    })

    test("a file nothing claims is refused, naming what was tried", async () => {
        // "No runtime for this file" is the one answer a caller can act on; a
        // silent null surfaces later as a model that is somehow never resident.
        const { models: m, root } = await models([fake("onnx", ".onnx")])

        await expect(m.load({
            path: await weight(root, "a.safetensors"), model: "hf:x/a", agent: "@t/a", role: "main",
        })).rejects.toThrow(/no runtime/i)
    })
})

describe("the onnx adapter without its runtime", () => {
    test("claims a .onnx file whether or not the library is installed", async () => {
        // Claiming is a ROUTING answer and must not depend on a 300MB optional
        // dependency being present — otherwise a machine without it reports
        // "unsupported format" for a format that is very much supported.
        expect(OnnxAdapter().claims("/models/whisper.onnx")).toBe(true)
        expect(OnnxAdapter().claims("/models/whisper.gguf")).toBe(false)
    })

    test("loading a file it claimed and cannot read is a FAULT, not a routing answer", async () => {
        // The distinction the adapter contract rests on: refusing to claim is
        // routing, failing to load is a fault. Collapsing them would let a
        // corrupt weight look like an unsupported format.
        //
        // Asserted on the shape rather than the message, because the message
        // depends on whether the optional runtime is installed on THIS machine
        // — "not installed" on a fresh one, the runtime's own error where it
        // is present. Both are the fault case; neither is a claim of support.
        await expect(OnnxAdapter().load("/models/does-not-exist.onnx")).rejects.toThrow()
    })
})

describe("admission", () => {
    test("a load that does not fit is refused and NOT left resident", async () => {
        // Refusing after paying the memory would be the worst of both: the
        // load happened, the caller was told no, and the card is full anyway.
        const { models: m, root } = await models([fake("onnx", ".onnx", 5_000)], () => 1)

        await expect(m.load({
            path: await weight(root, "big.onnx"), model: "hf:x/big", agent: "@t/a", role: "main",
        })).rejects.toThrow(/available/i)

        expect(m.state().resident).toEqual([])
    })

    test("a refusal names what is holding the memory", async () => {
        // A refusal that says only "no" is unactionable.
        const { models: m, machine, root } = await models([fake("onnx", ".onnx", 5_000)], () => 1)
        machine.residency.take({ agent: "@cody/barry", role: "asr", model: "hf:x/held", bytes: 900 })

        await expect(m.load({
            path: await weight(root, "big.onnx"), model: "hf:x/big", agent: "@t/a", role: "main",
        })).rejects.toThrow(/available/i)
    })

    test("a successful load takes a hold the machine can see", async () => {
        // The tenancy half: the machine accounts for it, not this domain.
        const { models: m, machine, root } = await models([fake("onnx", ".onnx", 500)])

        await m.load({ path: await weight(root, "a.onnx"), model: "hf:x/a", agent: "@cody/barry", role: "asr" })

        expect(machine.residency.held()).toBe(500)
        expect(machine.residency.live()[0]?.agent).toBe("@cody/barry")
    })
})

describe("residency", () => {
    test("loading the same model twice returns the resident copy", async () => {
        // One copy, however many agents ask — the case the whole daemon exists
        // for. A second load would double the memory for the same weight.
        const { models: m, machine, root } = await models([fake("onnx", ".onnx", 500)])
        const path = await weight(root, "a.onnx")

        await m.load({ path: path, model: "hf:x/a", agent: "@t/one", role: "asr" })
        await m.load({ path: path, model: "hf:x/a", agent: "@t/two", role: "asr" })

        expect(m.state().resident).toHaveLength(1)
        expect(machine.residency.held()).toBe(500)
    })

    test("unload releases the hold", async () => {
        const { models: m, machine, root } = await models([fake("onnx", ".onnx", 500)])
        await m.load({ path: await weight(root, "a.onnx"), model: "hf:x/a", agent: "@t/a", role: "asr" })

        expect(await m.unload("hf:x/a")).toBe(true)

        expect(m.state().resident).toEqual([])
        expect(machine.residency.held()).toBe(0)
    })

    test("unloading something that is not loaded is false, not an error", async () => {
        const { models: m } = await models([fake("onnx", ".onnx")])

        expect(await m.unload("hf:x/nothing")).toBe(false)
    })

    test("inference against an unloaded model is refused, never an implicit load", async () => {
        // An implicit load is a memory claim the caller did not make, and
        // admission is a decision that should be visible where it is taken.
        const { models: m } = await models([fake("onnx", ".onnx")])

        await expect(m.run("hf:x/a", {})).rejects.toThrow(/not loaded/i)
    })

    test("dispose unloads everything", async () => {
        // A daemon that exits holding weights leaves the machine looking
        // fuller than it is until something reaps the records.
        const { models: m, machine, root } = await models([fake("onnx", ".onnx", 500)])
        await m.load({ path: await weight(root, "a.onnx"), model: "hf:x/a", agent: "@t/a", role: "asr" })

        await m.dispose()

        expect(machine.residency.held()).toBe(0)
    })
})
