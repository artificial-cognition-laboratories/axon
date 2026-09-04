import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Boot } from "@arcforge/platform/build/blueprint/scan/boot"
import { describe, it, expect } from "bun:test"

describe("Boot()", () => {
    it("returns empty warnings and no boot content when neither file exists", async () => {
        const dir = await mkdtemp(join(tmpdir(), "axon-test-noboot-"))

        try {
            const result = await Boot(dir)

            expect(result).toEqual({ warnings: [] })
        } finally {
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("boot.vue present — reports its path for the runtime to render dynamically", async () => {
        const dir = await mkdtemp(join(tmpdir(), "axon-test-bootvue-"))

        try {
            await mkdir(join(dir, "src"), { recursive: true })
            await writeFile(join(dir, "src", "boot.vue"), "<template>hi</template>\n")

            const result = await Boot(dir)

            expect(result).toEqual({ bootFilePath: join(dir, "src", "boot.vue"), warnings: [] })
        } finally {
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("boot.md present — reads the static content directly", async () => {
        const dir = await mkdtemp(join(tmpdir(), "axon-test-bootmd-"))

        try {
            await mkdir(join(dir, "src"), { recursive: true })
            await writeFile(join(dir, "src", "boot.md"), "# Welcome\nThis is the boot context.\n")

            const result = await Boot(dir)

            expect(result).toEqual({ boot: "# Welcome\nThis is the boot context.\n", warnings: [] })
        } finally {
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("boot.vue takes precedence when both boot.vue and boot.md exist", async () => {
        const dir = await mkdtemp(join(tmpdir(), "axon-test-bootboth-"))

        try {
            await mkdir(join(dir, "src"), { recursive: true })
            await writeFile(join(dir, "src", "boot.vue"), "<template>dynamic</template>\n")
            await writeFile(join(dir, "src", "boot.md"), "static content\n")

            const result = await Boot(dir)

            expect("bootFilePath" in result).toBe(true)
            expect("boot" in result).toBe(false)
        } finally {
            await rm(dir, { recursive: true, force: true })
        }
    })
})
