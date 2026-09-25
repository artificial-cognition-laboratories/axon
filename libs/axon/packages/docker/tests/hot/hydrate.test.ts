import { describe, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hydrate } from "../../hydrate"

const AGENT = join(import.meta.dir, "../../../../../../registry/agents/barry.mk3")

describe("Hydrate", () => {
    it("is a no-op when source is already present (staging path)", async () => {
        const result = await Hydrate({ agentRoot: AGENT })
        expect(result.status).toBe("present")
    })

    it("fails loudly when there is no source and no fetch target", async () => {
        const empty = await mkdtemp(join(tmpdir(), "axon-boot-empty-"))
        try {
            await expect(Hydrate({ agentRoot: empty })).rejects.toThrow()
        } finally {
            await rm(empty, { recursive: true, force: true })
        }
    })
})
