import { describe, it, expect } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readMeta } from "@arcforge/platform/build/blueprint/modules/meta"

/**
 * readMeta AST-reads a module.config.ts's static shape (env, options,
 * automerge) without executing it. The module authoring style annotates
 * option types with `as const` — the reader must see through the
 * AsExpression, or a boolean/number option's type silently falls back to
 * "string" and every non-string option fails validation at boot.
 */
describe("readMeta options schema", () => {
    async function meta(source: string) {
        const dir = await mkdtemp(join(tmpdir(), "meta-test-"))
        const path = join(dir, "module.config.ts")
        await writeFile(path, source)
        try {
            return await readMeta(path)
        } finally {
            await rm(dir, { recursive: true, force: true })
        }
    }

    it("reads option types annotated with `as const`", async () => {
        const m = await meta(`
            export default defineModule({
                options: {
                    name:  { type: "string" as const, required: false },
                    loud:  { type: "boolean" as const, default: false },
                    count: { type: "number" as const, default: 3 },
                },
            })
        `)

        expect(m.optionsSchema.name!.type).toBe("string")
        expect(m.optionsSchema.loud!.type).toBe("boolean")
        expect(m.optionsSchema.count!.type).toBe("number")
    })

    it("reads defaults through `as const` and plain literals", async () => {
        const m = await meta(`
            export default defineModule({
                options: {
                    loud:  { type: "boolean" as const, default: true },
                    count: { type: "number" as const, default: 7 },
                    label: { type: "string", default: "hi" },
                },
            })
        `)

        expect(m.optionsSchema.loud!.default).toBe(true)
        expect(m.optionsSchema.count!.default).toBe(7)
        expect(m.optionsSchema.label!.default).toBe("hi")
    })

    it("reads required and plain (unannotated) option types", async () => {
        const m = await meta(`
            export default defineModule({
                options: {
                    token: { type: "string", required: true },
                },
            })
        `)

        expect(m.optionsSchema.token!.type).toBe("string")
        expect(m.optionsSchema.token!.required).toBe(true)
    })
})
