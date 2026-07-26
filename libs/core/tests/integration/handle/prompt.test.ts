import { writeFile, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Axon } from "../../setup/axon"

describe("axon.prompt", () => {
    it("renders a static markdown prompt as-is", async () => {
        const dir = await mkdtemp(path.join(tmpdir(), "axon-prompt-test-"))
        const filePath = path.join(dir, "hello.md")
        await writeFile(filePath, "# Hello prompt\n")

        const runtime = await Axon({
            blueprint: { prompts: [{ name: "hello", kind: "static", filePath }] },
        })

        const rendered = await runtime.axon.prompt("hello")

        expect(rendered).toBe("# Hello prompt\n")

        await runtime.shutdown()
        await rm(dir, { recursive: true, force: true })
    })

    it("throws PROMPT_NOT_FOUND for a name not in the blueprint", async () => {
        const runtime = await Axon()

        await expect(runtime.axon.prompt("nonexistent")).rejects.toMatchObject({ code: "AX-PROMPT-001" })

        await runtime.shutdown()
    })

    it("throws PROMPT_FILE_NOT_FOUND when the entry has no filePath", async () => {
        const runtime = await Axon({
            blueprint: { prompts: [{ name: "broken", kind: "static" }] },
        })

        await expect(runtime.axon.prompt("broken")).rejects.toMatchObject({ code: "AX-PROMPT-002" })

        await runtime.shutdown()
    })

    it("does not confuse two different prompt names", async () => {
        const dir = await mkdtemp(path.join(tmpdir(), "axon-prompt-test-"))
        const helloPath = path.join(dir, "hello.md")
        const byePath = path.join(dir, "bye.md")
        await writeFile(helloPath, "hello content")
        await writeFile(byePath, "bye content")

        const runtime = await Axon({
            blueprint: {
                prompts: [
                    { name: "hello", kind: "static", filePath: helloPath },
                    { name: "bye", kind: "static", filePath: byePath },
                ],
            },
        })

        expect(await runtime.axon.prompt("hello")).toBe("hello content")
        expect(await runtime.axon.prompt("bye")).toBe("bye content")

        await runtime.shutdown()
        await rm(dir, { recursive: true, force: true })
    })
})
