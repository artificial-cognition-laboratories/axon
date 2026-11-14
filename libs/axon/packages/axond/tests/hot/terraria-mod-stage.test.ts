import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Install } from "../../src/labs/terraria/install"
import { Mod } from "../../src/labs/terraria/mod"

test("Terraria stages the enabled list where the dedicated server reads it", async () => {
    const root = await mkdtemp(join(tmpdir(), "axon-terraria-stage-"))
    try {
        const install = Install({ root: join(root, "lab"), userDir: join(root, "user") })
        await mkdir(join(root, "user", "Mods"), { recursive: true })
        await Bun.write(install.builtMod, "mod bytes")
        await Mod({ install: install }).stage()
        expect(await readFile(join(install.lab.serverSave, "Mods", "enabled.json"), "utf-8")).toContain("AxonT")
        expect(await readFile(join(install.lab.serverSave, "Mods", "AxonT.tmod"), "utf-8")).toBe("mod bytes")
    } finally {
        await rm(root, { recursive: true, force: true })
    }
})
