import { afterEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Axond } from "../../src/index.ts"

/**
 * The daemon's shell — is it up, can it start, can it stop.
 *
 * Driven through `Axond()` DIRECTLY, with no socket and no subprocess. That is
 * the property the two-root design buys: the composition root is the same
 * object `bin/axond.ts` boots, so exercising it here tests what actually
 * runs — and the transport gets its own suite rather than every domain test
 * paying for a live server.
 */

const roots: string[] = []
afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function daemon() {
    const root = await mkdtemp(join(tmpdir(), "axond-test-"))
    roots.push(root)
    return Axond({ root: root, version: "9.9.9" })
}

describe("daemon lifecycle", () => {
    test("a fresh daemon reports itself down", async () => {
        const axond = await daemon()

        expect(axond.lifecycle.status()).toEqual({ running: false })
        expect(axond.lifecycle.pid()).toBeNull()
    })

    test("serving claims the pidfile and reports up", async () => {
        const axond = await daemon()
        try {
            await axond.serve()

            const state = axond.lifecycle.status()
            expect(state.running).toBe(true)
            // Narrowed rather than asserted loosely: a stopped daemon carries
            // no pid, and the type says so.
            if (state.running) {
                expect(state.pid).toBe(process.pid)
                expect(state.version).toBe("9.9.9")
            }
        } finally {
            await axond.shutdown()
        }
    })

    test("a second serve on the same root is refused", async () => {
        // Two daemons would each believe they owned the GPU — the one failure
        // the whole design exists to prevent.
        const axond = await daemon()
        try {
            await axond.serve()
            const second = Axond({ root: axond.paths.root })

            await expect(second.serve()).rejects.toThrow(/already/i)
        } finally {
            await axond.shutdown()
        }
    })

    test("shutdown releases the pidfile and the socket", async () => {
        const axond = await daemon()
        await axond.serve()

        await axond.shutdown()

        expect(axond.lifecycle.status()).toEqual({ running: false })
        // A socket left behind is what makes the NEXT start fail with
        // EADDRINUSE against nothing.
        expect(existsSync(axond.paths.socket)).toBe(false)
    })

    test("shutdown is idempotent", async () => {
        const axond = await daemon()
        await axond.serve()

        await axond.shutdown()
        await axond.shutdown()

        expect(axond.lifecycle.status()).toEqual({ running: false })
    })

    test("down reports false when nothing was running", async () => {
        // "Stopped nothing" and "stopped something" are different answers, and
        // a caller printing "stopped" for both would lie.
        const axond = await daemon()

        expect(axond.lifecycle.down()).toBe(false)
    })

    test("a stale pidfile does not make a dead daemon look alive", async () => {
        // A process killed with -9 leaves one behind. Trusting it would report
        // a daemon that is gone, and refuse to start a real one.
        const axond = await daemon()
        await Bun.write(axond.paths.pid, "999999")

        expect(axond.lifecycle.pid()).toBeNull()
        expect(axond.lifecycle.status()).toEqual({ running: false })
    })
})

describe("domains", () => {
    test("machine, agents and models answer, because they are wired", async () => {
        const axond = await daemon()

        expect(axond.machine.state().capacity.cores).toBeGreaterThan(0)
        expect(Array.isArray(axond.agents.state().agents)).toBe(true)
        expect(Array.isArray(axond.models.state().resident)).toBe(true)
    })

    test("the schedule domain answers with durable state", async () => {
        const axond = await daemon()

        expect(axond.schedule.state()).toEqual({
            schedules: [],
            running: false,
            nextRunAt: null,
        })
    })
})

describe("a detached daemon's paths", () => {
    /**
     * The regression: `daemonPaths()` reads NODE_ENV to pick `~/.axon` or
     * `~/.axon-dev`, but a bundler INLINES that value — so in a published CLI
     * `process.env.NODE_ENV` is undefined at runtime and a spawned child
     * re-deriving the answer got "development" while the parent that spawned
     * it had "production" compiled in. The client then waited out its timeout
     * on a socket the daemon was never going to bind, and `axon daemon up`
     * failed for every user of a published build.
     *
     * Asserted through the OBSERVABLE property rather than by intercepting the
     * spawn: a daemon started under an explicit root must be reachable at that
     * root's socket, whatever the environment says. A child that re-derived
     * its own answer would bind elsewhere and this would time out.
     */
    test("a daemon started under an explicit root is reachable there", async () => {
        const root = await mkdtemp(join(tmpdir(), "axond-spawn-"))
        roots.push(root)

        const axond = Axond({ root: root, version: "9.9.9" })
        await axond.serve()

        // The socket exists where the caller said it would, not where a
        // re-derivation from NODE_ENV would have put it.
        expect(existsSync(axond.paths.socket)).toBe(true)
        expect(axond.paths.socket.startsWith(root)).toBe(true)

        await axond.shutdown()
    })
})

describe("a machine with no ~/.axon yet", () => {
    /**
     * The regression: `Server.listen()` bound the socket before `Lifecycle`
     * created its directory — deliberately, so that a live pidfile always
     * implies a listening socket. On a fresh install that ordering made the
     * very first `axon daemon up` die with `ENOENT: listen`: the first thing a
     * new user does was the one thing that could not work.
     */
    test("the first start creates the socket's directory", async () => {
        const parent = await mkdtemp(join(tmpdir(), "axond-fresh-"))
        roots.push(parent)

        // Nothing exists below it — the state a machine is in before Axon has
        // ever run on it.
        const root = join(parent, "never", "created", "daemon")
        expect(existsSync(root)).toBe(false)

        const axond = Axond({ root: root, version: "9.9.9" })
        await axond.serve()

        expect(existsSync(axond.paths.socket)).toBe(true)

        await axond.shutdown()
    })
})

/**
 * A daemon from an older build is not a running daemon.
 *
 * `axon update` replaces the CLI and never touches the supervisor, and `up`
 * returned `already` on the strength of a live pid alone. So the new CLI
 * talked to whatever was listening — indefinitely, since `up` runs before
 * every agent command and nothing ever told the user to restart. Observed
 * with 28h uptime across a day of releases: the CLI dispatched verbs the old
 * process had never heard of and got DAEMON_NOT_WIRED.
 *
 * The diagnostic made it invisible. `status()` reported `opts.version` — the
 * CALLER'S build, not the running daemon's — so the one command that should
 * have revealed a stale daemon confirmed it was current.
 */
describe("daemon staleness", () => {
    test("the pidfile records the build that wrote it", async () => {
        // On the record rather than asked for over the socket: "is the running
        // daemon current" has to be answerable before a client dials one.
        const axond = await daemon()
        try {
            await axond.serve()
            expect(axond.lifecycle.status().version).toBe("9.9.9")
        } finally {
            await axond.shutdown()
        }
    })

    test("status reports the RUNNING build, not the caller's", async () => {
        // The bug that made this invisible: status echoed `opts.version`, so
        // whichever CLI asked saw its own number and a daemon left behind by
        // an update looked current.
        const root = await mkdtemp(join(tmpdir(), "axond-test-"))
        roots.push(root)

        const serving = Axond({ root, version: "1.0.0" })
        try {
            await serving.serve()
            // A DIFFERENT build asking. It must not see its own version.
            expect(Axond({ root, version: "2.0.0" }).lifecycle.status().version).toBe("1.0.0")
        } finally {
            await serving.shutdown()
        }
    })

    test("a matching build is recognised as already running", async () => {
        // The common path must not restart the supervisor on every command.
        const root = await mkdtemp(join(tmpdir(), "axond-test-"))
        roots.push(root)

        const serving = Axond({ root, version: "1.0.0" })
        try {
            await serving.serve()
            const status = Axond({ root, version: "1.0.0" }).lifecycle.status()
            expect(status.running).toBe(true)
            if (status.running) expect(status.version).toBe("1.0.0")
        } finally {
            await serving.shutdown()
        }
    })

    test("a record with no version reads as stale, never as current", async () => {
        // A pidfile written by a build that predates this field predates
        // everything after it too. "Unknown" is the honest answer and it must
        // not compare equal to a real version.
        const root = await mkdtemp(join(tmpdir(), "axond-test-"))
        roots.push(root)

        const serving = Axond({ root, version: "1.0.0" })
        try {
            await serving.serve()
            const paths = serving.paths
            // Rewrite as the OLD format: a bare pid, no version line.
            await Bun.write(paths.pid, String(process.pid))

            expect(Axond({ root, version: "1.0.0" }).lifecycle.status().version).toBe("unknown")
        } finally {
            await serving.shutdown()
        }
    })
})
