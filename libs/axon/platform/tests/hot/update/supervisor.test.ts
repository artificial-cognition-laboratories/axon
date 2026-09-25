import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { supervise } from "@arcforge/platform/bin/supervisor"
import { UPDATE_REQUEST_ENV, UPDATE_REQUEST_EXIT_CODE, type UpdateRequest } from "@arcforge/platform/update"

/**
 * The real CLI entrypoint.
 *
 * Every `axon` invocation is this process spawning the app as a child. It
 * exists for one reason: an update cannot replace the binary of a running
 * program, so something must outlive the app and run the installer after it
 * exits.
 *
 * `spawn` is injected, so the whole handshake is exercised without launching
 * anything — which matters, because the alternative is a path only ever
 * verified by shipping it.
 */

const roots: string[] = []
afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function scratch(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "axon-supervisor-"))
    roots.push(root)
    return root
}

const REQUEST: UpdateRequest = {
    from: "2.0.20",
    to: "2.0.21",
    bun: "/bun",
    axon: "/axon",
    state: "/tmp/axon-update-state.json",
}

/**
 * A Bun.spawn stand-in that records invocations and answers with fixed exit codes.
 *
 * Records the OPTIONS form, because that is what the supervisor uses: naming a
 * process requires `argv0`, which the positional form cannot express. `calls`
 * keeps the command arrays for the existing assertions, and `argv0s` the names,
 * so a test can check either without every assertion growing a shape.
 */
function spawner(codes: number[]) {
    const calls: string[][] = []
    const argv0s: Array<string | undefined> = []
    let index = 0
    const spawn = ((options: { cmd: string[]; argv0?: string }) => {
        calls.push(options.cmd)
        argv0s.push(options.argv0)
        const code = codes[index++] ?? 0
        return { exited: Promise.resolve(code) }
    }) as unknown as typeof Bun.spawn
    return { spawn, calls, argv0s }
}

describe("supervisor", () => {
    test("passes the app's exit code straight through when no update was requested", async () => {
        const { spawn, calls } = spawner([0])

        const code = await supervise({
            argv: ["dev"],
            execPath: "/bun",
            root: "/pkg",
            requestPath: join(await scratch(), "request.json"),
            spawn,
        })

        expect(code).toBe(0)
        expect(calls).toHaveLength(1) // no helper spawned
        expect(calls[0]).toEqual(["/bun", "/pkg/app.js", "dev"])
    })

    test("passes a nonzero app exit through unchanged — the supervisor is transparent", async () => {
        const { spawn, calls } = spawner([17])

        const code = await supervise({
            execPath: "/bun",
            root: "/pkg",
            requestPath: join(await scratch(), "request.json"),
            spawn,
        })

        expect(code).toBe(17)
        expect(calls).toHaveLength(1)
    })

    test("spawns the helper with the request's argv when the app asks for an update", async () => {
        const root = await scratch()
        const requestPath = join(root, "request.json")
        await writeFile(requestPath, JSON.stringify(REQUEST))
        const { spawn, calls } = spawner([UPDATE_REQUEST_EXIT_CODE, 0])

        const code = await supervise({ execPath: "/bun", root: "/pkg", requestPath, spawn })

        expect(code).toBe(0)
        expect(calls).toHaveLength(2)
        expect(calls[1]).toEqual([
            "/bun", "/pkg/update-helper.js",
            "--from", "2.0.20",
            "--to", "2.0.21",
            "--bun", "/bun",
            "--axon", "/axon",
            "--state", "/tmp/axon-update-state.json",
        ])
    })

    test("returns the helper's exit code, not the app's sentinel", async () => {
        const root = await scratch()
        const requestPath = join(root, "request.json")
        await writeFile(requestPath, JSON.stringify(REQUEST))
        const { spawn } = spawner([UPDATE_REQUEST_EXIT_CODE, 1])

        const code = await supervise({ execPath: "/bun", root: "/pkg", requestPath, spawn })

        expect(code).toBe(1)
    })

    test("tells the app where to write its request", async () => {
        const requestPath = join(await scratch(), "request.json")
        const envs: Array<Record<string, string>> = []
        const spawn = ((options: { env: Record<string, string> }) => {
            envs.push(options.env)
            return { exited: Promise.resolve(0) }
        }) as unknown as typeof Bun.spawn

        await supervise({ execPath: "/bun", root: "/pkg", requestPath, spawn })

        expect(envs[0]?.[UPDATE_REQUEST_ENV]).toBe(requestPath)
    })

    /**
     * ── Process naming ──────────────────────────────────────────────────────
     *
     * Every axon process showed up as `bun` in ps/top/htop, so "which bun is
     * eating my CPU" could only be answered by matching on a script path.
     *
     * `process.title = "axon"` is the obvious fix and does not work under Bun:
     * the assignment is accepted and reads back, but never reaches the OS.
     * argv0 does, because the kernel reports argv[0] as the command line — so
     * these assert on argv0 specifically, not on any title.
     */
    test("names the app process after the product, not the runtime", async () => {
        const { spawn, argv0s } = spawner([0])

        await supervise({ execPath: "/bun", root: "/pkg", requestPath: join(await scratch(), "request.json"), spawn })

        expect(argv0s[0]).toBe("axon")
    })

    test("names the updater distinctly from the app", async () => {
        // An update running after the TUI exits is a different thing doing
        // different work; two rows called `axon` would not say which is alive.
        const root = await scratch()
        const requestPath = join(root, "request.json")
        await writeFile(requestPath, JSON.stringify(REQUEST))
        const { spawn, argv0s } = spawner([UPDATE_REQUEST_EXIT_CODE, 0])

        await supervise({ execPath: "/bun", root: "/pkg", requestPath, spawn })

        expect(argv0s[0]).toBe("axon")
        expect(argv0s[1]).toBe("axon-update")
    })

    test("removes the request file afterwards — a stale request must not replay next launch", async () => {
        const root = await scratch()
        const requestPath = join(root, "request.json")
        await writeFile(requestPath, JSON.stringify(REQUEST))
        const { spawn } = spawner([UPDATE_REQUEST_EXIT_CODE, 0])

        await supervise({ execPath: "/bun", root: "/pkg", requestPath, spawn })

        expect(existsSync(requestPath)).toBe(false)
    })

    test("cleans up even when the app crashes", async () => {
        const root = await scratch()
        const requestPath = join(root, "request.json")
        await writeFile(requestPath, "not json at all")
        const { spawn } = spawner([UPDATE_REQUEST_EXIT_CODE])

        // The app claimed an update but left an unreadable request — the read
        // throws, and the cleanup still has to run.
        await expect(supervise({ execPath: "/bun", root: "/pkg", requestPath, spawn })).rejects.toBeDefined()

        expect(existsSync(requestPath)).toBe(false)
    })
})
