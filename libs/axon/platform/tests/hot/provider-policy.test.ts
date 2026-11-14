import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ProfileProviders } from "../../src/services"
import { ProfileConfigFile } from "../../src/build/extensions"

test("a broken profile cannot enable default account discovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "axon-provider-policy-"))
    const policy = ProfileProviders({ root: () => root, read: ProfileConfigFile })
    try {
        await writeFile(join(root, "profile.config.ts"), "throw new Error('invalid policy fixture')\n")
        await expect(policy.read()).rejects.toThrow("invalid policy fixture")
    } finally { await rm(root, { recursive: true, force: true }) }
})
