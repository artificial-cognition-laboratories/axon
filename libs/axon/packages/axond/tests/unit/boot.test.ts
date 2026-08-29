import { afterEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises"
import { join, dirname } from "node:path"
import { tmpdir } from "node:os"
import { Boot } from "../../src/control/boot"

/**
 * Starting with the machine.
 *
 * The unit is installed SILENTLY on first `up`, which is a strong default —
 * so what is asserted here is the set of properties that make it defensible:
 * it lives in the user's own home, it is removable, it repairs itself when
 * stale, and it refuses to install a command that does not work.
 *
 * `command` is `["echo"]` throughout: the verification step runs it, and a
 * test that shelled out to the real CLI would be asserting the CLI's presence
 * rather than this module's behaviour.
 */

const roots: string[] = []
afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function boot(command: string[] = ["echo"]) {
    const root = await mkdtemp(join(tmpdir(), "axond-boot-"))
    roots.push(root)
    return Boot({ command: command, root: root })
}

describe("boot install", () => {
    test("a fresh machine has no unit", async () => {
        const b = await boot()

        expect(b.installed()).toBe(false)
    })

    test("install writes a unit naming the command", async () => {
        const b = await boot(["echo", "daemon", "serve"])

        b.install()

        expect(b.installed()).toBe(true)
        expect(await readFile(b.unit().path, "utf-8")).toContain("ExecStart=echo daemon serve")
    })

    test("the unit lives in the user's own config, never system-wide", async () => {
        // What bounds a silent install: no root, no shared state, and removal
        // is deleting a file the user owns.
        const b = await boot()

        expect(b.unit().path).toContain(join("systemd", "user"))
    })

    test("installing twice does not rewrite an identical unit", async () => {
        // `up` installs every time, and rewriting a file the init system
        // watches on every start is churn for nothing.
        const b = await boot()
        b.install()
        const first = await readFile(b.unit().path, "utf-8")

        b.install()

        expect(await readFile(b.unit().path, "utf-8")).toBe(first)
    })

    test("a unit naming a stale command reads as NOT installed", async () => {
        // The failure this catches is silent: a unit pointing at a binary that
        // has moved fails at boot, unattended, and the daemon a person
        // believes is running is not.
        const b = await boot(["echo", "new"])
        await mkdir(dirname(b.unit().path), { recursive: true })
        await writeFile(b.unit().path, "ExecStart=echo old\n")

        expect(b.installed()).toBe(false)
    })

    test("a stale unit is repaired by install", async () => {
        const b = await boot(["echo", "new"])
        await mkdir(dirname(b.unit().path), { recursive: true })
        await writeFile(b.unit().path, "ExecStart=echo old\n")

        b.install()

        expect(await readFile(b.unit().path, "utf-8")).toContain("ExecStart=echo new")
    })

    test("a command that does not work is refused, not installed", async () => {
        // A unit is only ever exercised at boot, by the init system, with
        // nobody watching — so one that cannot run must never be written.
        const b = await boot(["definitely-not-a-real-binary-xyz"])

        expect(b.install()).toBe(false)
        expect(existsSync(b.unit().path)).toBe(false)
    })
})

describe("boot disable", () => {
    test("removes the unit", async () => {
        // The way out that makes a silent install defensible.
        const b = await boot()
        b.install()
        expect(b.installed()).toBe(true)

        b.disable()

        expect(b.installed()).toBe(false)
        expect(existsSync(b.unit().path)).toBe(false)
    })

    test("disabling when nothing is installed is not an error", async () => {
        const b = await boot()

        expect(() => b.disable()).not.toThrow()
    })
})
