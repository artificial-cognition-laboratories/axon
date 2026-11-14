import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { chmodSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Jvm } from "../../src/labs/minecraft/jvm"

const roots: string[] = []

/** A Prism `java/` tree holding a fake runtime that reports the major it is named for. */
async function prismWithRuntime(major: number) {
    const root = await mkdtemp(join(tmpdir(), "axond-jvm-"))
    roots.push(root)
    const bin = join(root, "java", `java-runtime-${major}`, "bin")
    await mkdir(bin, { recursive: true })
    const binary = join(bin, "java")
    // `-version` goes to stderr, and has done for twenty years — a fake that
    // wrote it to stdout would pass a test the real thing fails.
    await writeFile(binary, `#!/bin/sh\necho 'openjdk version "${major}.0.7" 2025-04-15 LTS' 1>&2\n`)
    chmodSync(binary, 0o755)
    return { root: root, binary: binary }
}

describe("minecraft jvm", () => {
    test("prefers Prism's own runtime for the major the game accepts", async () => {
        const { root, binary } = await prismWithRuntime(21)

        expect(await Jvm({ prism: root }).forMajors([21])).toBe(binary)
        expect(await Jvm({ prism: root }).problem([21])).toBeNull()
    })

    /**
     * The mismatch this leaf exists for. Minecraft names the majors it accepts —
     * 1.21.11 accepts 21, 26.3 accepts 25 — and running one on the other dies
     * somewhere inside startup with a message about something else.
     */
    test("refuses a Java whose major the game does not accept, naming what it found", async () => {
        const { root } = await prismWithRuntime(21)
        const jvm = Jvm({ prism: root })

        // Nothing on any machine is Java 7, so this is a stable "no fit".
        expect(await jvm.forMajors([7])).toBeNull()
        const problem = await jvm.problem([7])
        expect(problem).toContain("no installed Java satisfies Java 7")
        expect(problem).toContain("(21)")
        await expect(jvm.require([7])).rejects.toThrow()
    })

    test("an explicit JDK wins over anything discovered", async () => {
        const { root } = await prismWithRuntime(21)
        const other = await prismWithRuntime(25)

        expect(await Jvm({ prism: root, java: other.binary }).forMajors([25])).toBe(other.binary)
    })

    test("a version naming no requirement takes whatever is installed", async () => {
        const { root, binary } = await prismWithRuntime(21)

        expect(await Jvm({ prism: root }).forMajors([])).toBe(binary)
    })

    test("says so plainly when the machine has no Java at all", async () => {
        const root = await mkdtemp(join(tmpdir(), "axond-jvm-bare-"))
        roots.push(root)
        // An unreadable binary is not a Java: it is skipped, not trusted.
        const jvm = Jvm({ prism: root, java: join(root, "not-a-java") })

        expect(await jvm.forMajors([7])).toBeNull()
        expect(await jvm.problem([7])).toContain("no installed Java satisfies Java 7")
    })
})

afterAll(async () => {
    await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })))
})
