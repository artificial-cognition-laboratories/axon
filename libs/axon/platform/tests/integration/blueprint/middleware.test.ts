import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Middleware } from "@arcforge/platform/build/blueprint/scan/middleware"
import { describe, it, expect } from "bun:test"

/**
 * The middleware scanner — `server/middleware/` discovery.
 *
 * Mirrors the route and plugin scanners: import each file, resolve its
 * handler, and turn an unusable file into a warning rather than a crash. The
 * one thing it adds is ORDER — middleware is the only surface where sequence
 * is part of the contract, so it is asserted here rather than left to
 * whatever order the filesystem returned.
 */
describe("Middleware()", () => {
    async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
        const dir = await mkdtemp(join(tmpdir(), "axon-test-middleware-"))
        try {
            await mkdir(join(dir, "server", "middleware"), { recursive: true })
            await fn(dir)
        } finally {
            await rm(dir, { recursive: true, force: true })
        }
    }

    it("resolves a defineMiddleware() default export", async () => {
        await withDir(async dir => {
            await writeFile(
                join(dir, "server", "middleware", "auth.ts"),
                "export default defineMiddleware(() => {})\n",
            )

            const scanned = await Middleware(dir)

            expect(scanned.warnings).toEqual([])
            expect(scanned.entries).toHaveLength(1)
            expect(scanned.entries[0]?.name).toBe("auth")
            expect(typeof scanned.entries[0]?.handler).toBe("function")
        })
    })

    it("orders entries lexicographically by filename", async () => {
        await withDir(async dir => {
            // Written out of order on purpose — discovery order must not leak
            // into the contract.
            for (const name of ["20-log.ts", "10-auth.ts", "30-trace.ts"]) {
                await writeFile(
                    join(dir, "server", "middleware", name),
                    "export default defineMiddleware(() => {})\n",
                )
            }

            const scanned = await Middleware(dir)

            expect(scanned.entries.map(e => e.name)).toEqual(["10-auth", "20-log", "30-trace"])
        })
    })

    it("accepts a bare defineEventHandler default export", async () => {
        await withDir(async dir => {
            // The shape an author reaches for out of h3 habit. Refusing it
            // would fail a file that is otherwise perfectly valid.
            await writeFile(
                join(dir, "server", "middleware", "plain.ts"),
                "export default defineEventHandler(() => {})\n",
            )

            const scanned = await Middleware(dir)

            expect(scanned.warnings).toEqual([])
            expect(scanned.entries).toHaveLength(1)
            expect(scanned.entries[0]?.name).toBe("plain")
        })
    })

    it("warns and skips a file with no usable default export", async () => {
        await withDir(async dir => {
            await writeFile(
                join(dir, "server", "middleware", "broken.ts"),
                "export const notDefault = 1\n",
            )

            const scanned = await Middleware(dir)

            expect(scanned.entries).toEqual([])
            expect(scanned.warnings).toHaveLength(1)
            expect(scanned.warnings[0]?.domain).toBe("middleware")
        })
    })

    it("ignores .test.ts files", async () => {
        await withDir(async dir => {
            await writeFile(
                join(dir, "server", "middleware", "auth.test.ts"),
                "export default defineMiddleware(() => {})\n",
            )

            const scanned = await Middleware(dir)

            expect(scanned.entries).toEqual([])
            expect(scanned.warnings).toEqual([])
        })
    })

    it("returns nothing for an agent with no middleware directory", async () => {
        const dir = await mkdtemp(join(tmpdir(), "axon-test-middleware-none-"))
        try {
            const scanned = await Middleware(dir)
            expect(scanned.entries).toEqual([])
            expect(scanned.warnings).toEqual([])
        } finally {
            await rm(dir, { recursive: true, force: true })
        }
    })
})
