import { describe, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DIRECT_PROVIDERS } from "../../src/aisdk"

/** Proves the same literal-import strategy used by the CLI's Bun bundle. */
describe("shipped provider SDKs", () => {
    it("loads every SDK from a standalone bundle outside the workspace", async () => {
        const outdir = await mkdtemp(join(tmpdir(), "axon-provider-bundle-"))
        try {
            const build = await Bun.build({ entrypoints: [join(import.meta.dir, "fixtures/sdk-entry.ts")], outdir: outdir, target: "bun", minify: true })
            expect(build.success).toBe(true)
            const proc = Bun.spawn([process.execPath, join(outdir, "sdk-entry.js")], { cwd: outdir, env: { NODE_ENV: "production" }, stdout: "pipe", stderr: "pipe" })
            const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
            if (code !== 0) throw new Error(`Standalone provider bundle failed: ${stderr}`)
            expect(JSON.parse(stdout)).toEqual(Object.keys(DIRECT_PROVIDERS).sort())
        } finally { await rm(outdir, { recursive: true, force: true }) }
    })
})
