import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Manifest } from "@arcforge/platform/build/project"

describe("production deployment environment", () => {
    test("parses production dotenv syntax without exposing comments", () => {
        expect(Manifest({ root: "/nonexistent" }).env.parse(`
            TOKEN=hunter2
            URL="https://example.test/a#b"
            export ENABLED=true # production flag
        `)).toEqual({
            TOKEN: "hunter2",
            URL: "https://example.test/a#b",
            ENABLED: "true",
        })
    })

    test("rejects framework-owned variables", async () => {
        const root = await mkdtemp(join(tmpdir(), "axon-env-test-"))
        try {
            await writeFile(join(root, ".env"), "PORT=9999\n")
            await expect(Manifest({ root }).env.production()).rejects.toMatchObject({ code: "AX-PROJECT-043" })
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })
})
