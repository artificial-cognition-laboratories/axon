import { writeFile, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Axon } from "../../setup/axon"

async function scriptDir() {
    const dir = await mkdtemp(path.join(tmpdir(), "axon-script-test-"))
    return dir
}

describe("axon.scripts", () => {
    it("request() actually runs the script's top-level code", async () => {
        const dir = await scriptDir()
        const marker = path.join(dir, "ran.txt")
        const filePath = path.join(dir, "touch.ts")
        await writeFile(filePath, `
            import { writeFile } from "node:fs/promises"
            await writeFile("${marker}", "yes")
        `)

        const runtime = await Axon({
            blueprint: { scripts: [{ name: "touch", filePath }] },
        })

        await runtime.axon.scripts.request("touch")

        const { readFile } = await import("node:fs/promises")
        expect(await readFile(marker, "utf-8")).toBe("yes")

        await runtime.shutdown()
        await rm(dir, { recursive: true, force: true })
    })

    it("passes args through to the script as the global `args`", async () => {
        const dir = await scriptDir()
        const outPath = path.join(dir, "out.txt")
        const filePath = path.join(dir, "echo-args.ts")
        await writeFile(filePath, `
            import { writeFile } from "node:fs/promises"
            await writeFile("${outPath}", JSON.stringify(args))
        `)

        const runtime = await Axon({
            blueprint: { scripts: [{ name: "echo-args", filePath }] },
        })

        await runtime.axon.scripts.request("echo-args", { name: "world" })

        const { readFile } = await import("node:fs/promises")
        expect(JSON.parse(await readFile(outPath, "utf-8"))).toEqual({ name: "world" })

        await runtime.shutdown()
        await rm(dir, { recursive: true, force: true })
    })

    it("re-running the same script actually re-executes it, not a cached no-op", async () => {
        const dir = await scriptDir()
        const outPath = path.join(dir, "count.txt")
        const filePath = path.join(dir, "increment.ts")
        await writeFile(filePath, `
            import { readFile, writeFile } from "node:fs/promises"
            const prior = await readFile("${outPath}", "utf-8").catch(() => "0")
            await writeFile("${outPath}", String(Number(prior) + 1))
        `)

        const runtime = await Axon({
            blueprint: { scripts: [{ name: "increment", filePath }] },
        })

        await runtime.axon.scripts.request("increment")
        await runtime.axon.scripts.request("increment")
        await runtime.axon.scripts.request("increment")

        const { readFile } = await import("node:fs/promises")
        expect(await readFile(outPath, "utf-8")).toBe("3")

        await runtime.shutdown()
        await rm(dir, { recursive: true, force: true })
    })

    it("the axon global is available inside a script", async () => {
        const dir = await scriptDir()
        const filePath = path.join(dir, "uses-axon.ts")
        await writeFile(filePath, `
            if (typeof axon === "undefined") throw new Error("axon global missing")
        `)

        const runtime = await Axon({
            blueprint: { scripts: [{ name: "uses-axon", filePath }] },
        })

        await expect(runtime.axon.scripts.request("uses-axon")).resolves.toBeDefined()

        await runtime.shutdown()
        await rm(dir, { recursive: true, force: true })
    })

    it("throws SCRIPT_NOT_FOUND for a name not in the blueprint", async () => {
        const runtime = await Axon()

        await expect(runtime.axon.scripts.request("nonexistent")).rejects.toMatchObject({ code: "AX-SCRIPT-001" })

        await runtime.shutdown()
    })

    it("throws SCRIPT_FILE_NOT_FOUND when the entry's file doesn't exist on disk", async () => {
        const runtime = await Axon({
            blueprint: { scripts: [{ name: "ghost", filePath: "/nonexistent/path.ts" }] },
        })

        await expect(runtime.axon.scripts.request("ghost")).rejects.toMatchObject({ code: "AX-SCRIPT-002" })

        await runtime.shutdown()
    })

    it("propagates an error thrown by the script itself", async () => {
        const dir = await scriptDir()
        const filePath = path.join(dir, "throws.ts")
        await writeFile(filePath, `throw new Error("script blew up")`)

        const runtime = await Axon({
            blueprint: { scripts: [{ name: "throws", filePath }] },
        })

        await expect(runtime.axon.scripts.request("throws")).rejects.toThrow(/script blew up/)

        await runtime.shutdown()
        await rm(dir, { recursive: true, force: true })
    })

    it("list() returns every declared script", async () => {
        const runtime = await Axon({
            blueprint: { scripts: [{ name: "a", filePath: "/a.ts" }, { name: "b", filePath: "/b.ts" }] },
        })

        expect(runtime.axon.scripts.list().map(s => s.name).sort()).toEqual(["a", "b"])

        await runtime.shutdown()
    })
})
