import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Routes, parseRouteFile } from "@arcforge/platform/build/blueprint/scan/routes"

describe("parseRouteFile", () => {
    it("a bare filename with no method suffix is ANY", () => {
        expect(parseRouteFile("hello.ts")).toEqual({ method: "ANY", path: "/api/hello" })
    })

    it("a .get.ts suffix maps to GET", () => {
        expect(parseRouteFile("hello.get.ts")).toEqual({ method: "GET", path: "/api/hello" })
    })

    it("a .post.ts suffix maps to POST", () => {
        expect(parseRouteFile("hello.post.ts")).toEqual({ method: "POST", path: "/api/hello" })
    })

    it("a .ws.ts suffix maps to WS", () => {
        expect(parseRouteFile("chat.ws.ts")).toEqual({ method: "WS", path: "/api/chat" })
    })

    it("preserves nested directory segments and dynamic [id] segments in the path", () => {
        expect(parseRouteFile("users/[id].post.ts")).toEqual({ method: "POST", path: "/api/users/[id]" })
    })

    it("ignores .test.ts files entirely", () => {
        expect(parseRouteFile("hello.test.ts")).toBeNull()
    })

    it("ignores non-.ts files", () => {
        expect(parseRouteFile("hello.md")).toBeNull()
    })
})

describe("Routes()", () => {
    it("resolves a real route file's default-exported handler", async () => {
        const dir = await mkdtemp(join(tmpdir(), "axon-test-routes-"))

        try {
            await mkdir(join(dir, "server", "api"), { recursive: true })
            await writeFile(
                join(dir, "server", "api", "hello.post.ts"),
                "export default defineEventHandler(() => ({ ok: true }))\n",
            )

            const result = await Routes(dir)

            expect(result.warnings).toEqual([])
            expect(result.entries).toHaveLength(1)
            expect(result.entries[0]?.method).toBe("POST")
            expect(result.entries[0]?.path).toBe("/api/hello")
            expect(typeof result.entries[0]?.handler).toBe("function")
        } finally {
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("a route file with no default export warns rather than throwing", async () => {
        const dir = await mkdtemp(join(tmpdir(), "axon-test-routes-noexport-"))

        try {
            await mkdir(join(dir, "server", "api"), { recursive: true })
            await writeFile(join(dir, "server", "api", "hello.get.ts"), "export const notDefault = 1\n")

            const result = await Routes(dir)

            expect(result.entries).toEqual([])
            expect(result.warnings).toHaveLength(1)
            expect(result.warnings[0]?.error).toContain("no default-export handler")
        } finally {
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("a route file that throws on import fails the scan", async () => {
        // Previously warned-and-skipped. That made an agent serve an endpoint
        // set that was not the declared one — a caller gets a 404 for a file
        // sitting in server/api/ — and the warning reached nobody at runtime,
        // since scan warnings are printed only by `axon prepare` and `axon dev`
        // and were discarded on boot and on every reload. Same posture as a
        // tool that will not compile: an invalid state, not a degraded one.
        const dir = await mkdtemp(join(tmpdir(), "axon-test-routes-throws-"))

        try {
            await mkdir(join(dir, "server", "api"), { recursive: true })
            await writeFile(join(dir, "server", "api", "hello.get.ts"), "throw new Error('boom')\n")

            expect(Routes(dir)).rejects.toThrow(/hello\.get/)
        } finally {
            await rm(dir, { recursive: true, force: true })
        }
    })

    it("returns empty entries and warnings when server/api doesn't exist", async () => {
        const dir = await mkdtemp(join(tmpdir(), "axon-test-routes-empty-"))

        try {
            const result = await Routes(dir)

            expect(result.entries).toEqual([])
            expect(result.warnings).toEqual([])
        } finally {
            await rm(dir, { recursive: true, force: true })
        }
    })
})
