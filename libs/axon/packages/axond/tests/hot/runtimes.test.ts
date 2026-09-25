import { afterEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Runtimes } from "../../src/models/runtimes"

const roots: string[] = []
afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "axond-runtimes-"))
    roots.push(root)
    const calls: string[][] = []
    const runtimes = Runtimes({
        root,
        run: async (command, cwd) => {
            calls.push(command)
            // The installer is deliberately injected: these tests prove Axon's
            // ownership/layout without downloading native packages.
            await Bun.write(join(cwd, "node_modules", "onnxruntime-node", "index.js"), "export {}")
            return { ok: true, output: "" }
        },
    })
    return { root, calls, runtimes }
}

describe("local runtime environments", () => {
    test("starts with no native inference packages installed", async () => {
        const { runtimes } = await fixture()
        expect(runtimes.state()).toEqual([
            expect.objectContaining({ id: "onnx", installed: false }),
            expect.objectContaining({ id: "llama.cpp", installed: false }),
            expect.objectContaining({ id: "transformers", installed: false }),
        ])
    })

    test("installs only the requested runtime into Axon-owned versioned state", async () => {
        const { root, calls, runtimes } = await fixture()
        const installed = await runtimes.install("onnx")

        expect(calls).toEqual([[process.execPath, "install", "--production"]])
        expect(installed).toMatchObject({ id: "onnx", installed: true, path: join(root, "onnx", "1.29.0") })
        expect(existsSync(join(root, "onnx", "1.29.0", "manifest.json"))).toBe(true)
        expect(existsSync(join(root, ".staging"))).toBe(true)
        expect(runtimes.state().find(entry => entry.id === "llama.cpp")?.installed).toBe(false)
    })

    test("deduplicates concurrent requests for one backend", async () => {
        const { calls, runtimes } = await fixture()
        const [one, two] = await Promise.all([runtimes.install("onnx"), runtimes.install("onnx")])
        expect(one.path).toBe(two.path)
        expect(calls).toHaveLength(1)
    })

    test("failed installation leaves no ready runtime and a retry can promote one", async () => {
        const root = await mkdtemp(join(tmpdir(), "axond-runtimes-"))
        roots.push(root)
        let attempts = 0
        const runtimes = Runtimes({
            root,
            run: async (_command, cwd) => {
                attempts += 1
                if (attempts === 1) return { ok: false, output: "network failed" }
                await Bun.write(join(cwd, "node_modules", "onnxruntime-node", "index.js"), "export {}")
                return { ok: true, output: "" }
            },
        })

        await expect(runtimes.install("onnx")).rejects.toMatchObject({ code: "AX-MODEL-039" })
        expect(runtimes.state().find(entry => entry.id === "onnx")?.installed).toBe(false)
        expect(existsSync(join(root, "onnx", "1.29.0"))).toBe(false)

        await expect(runtimes.install("onnx")).resolves.toMatchObject({ installed: true })
        expect(attempts).toBe(2)
    })

    test("removes only an Axon-owned runtime environment", async () => {
        const { runtimes } = await fixture()
        await runtimes.install("onnx")
        expect(await runtimes.remove("onnx")).toBe(true)
        expect(runtimes.state().find(entry => entry.id === "onnx")?.installed).toBe(false)
    })
})
