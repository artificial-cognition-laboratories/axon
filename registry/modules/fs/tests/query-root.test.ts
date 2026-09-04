import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fs } from "../src/tools/fs"

/**
 * `query({ cwd })` is the root of a TREE WALK, but it reads as "where to
 * look" — and a file path is a perfectly sensible answer to that question.
 *
 * An agent supplied one repeatedly in a single session and got back
 * `ENOTDIR: not a directory, open 'libs/axon/packages/err/src/map.ts'` every
 * time: no parameter named, no fix suggested, and indistinguishable from a
 * path that does not exist. It recovered by guessing the parent directory.
 *
 * A file path here has exactly one sensible reading — "search this file" — so
 * it is resolved rather than refused. Refusing is still right for a path that
 * is not there at all, and that message now names the parameter and what it
 * wants.
 *
 * These drive the real tool against a real temp tree: a mocked fs would prove
 * nothing about the errno paths, which is the entire subject.
 */

let root: string

beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "axon-fs-query-"))
    mkdirSync(join(root, "src"), { recursive: true })
    writeFileSync(join(root, "src", "map.ts"), 'const severity = "fatal"\nconst other = 1\n')
    writeFileSync(join(root, "src", "other.ts"), 'const severity = "degraded"\n')
    writeFileSync(join(root, "README.md"), "# readme\nseverity\n")
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe("a file path passed as cwd", () => {
    it("searches that file instead of throwing ENOTDIR", async () => {
        // THE reported failure, reproduced in shape: cwd naming a file.
        const result = await fs.query({ pattern: "severity", cwd: join(root, "src", "map.ts") })

        expect(result.matches).toHaveLength(1)
        expect(result.matches[0]?.path).toBe("map.ts")
    })

    it("searches ONLY that file, not its whole directory", async () => {
        // Resolving to the parent directory and searching all of it would be
        // a different query than the caller asked for — `other.ts` also
        // matches, and returning it would be us inventing scope.
        const result = await fs.query({ pattern: "severity", cwd: join(root, "src", "map.ts") })

        expect(result.matches.map(m => m.path)).toEqual(["map.ts"])
    })

    it("lets an explicit glob win over the inferred one", async () => {
        // A caller who passed both said something more specific than we can
        // infer, so the inference must not overrule it.
        const result = await fs.query({
            pattern: "severity",
            cwd: join(root, "src", "map.ts"),
            glob: "*.ts",
        })

        expect(result.matches.map(m => m.path).sort()).toEqual(["map.ts", "other.ts"])
    })
})

describe("an ordinary directory cwd is untouched", () => {
    it("searches the tree beneath it", async () => {
        const result = await fs.query({ pattern: "severity", cwd: join(root, "src") })

        expect(result.matches.map(m => m.path).sort()).toEqual(["map.ts", "other.ts"])
    })

    it("still honours glob within it", async () => {
        const result = await fs.query({ pattern: "severity", cwd: root, glob: "*.md" })

        expect(result.matches.map(m => m.path)).toEqual(["README.md"])
    })

    it("defaults to the process cwd when omitted", async () => {
        // Absence must not be mistaken for a file path.
        const result = await fs.query({ glob: "package.json", limit: 1 })

        expect(result.matches.length).toBeGreaterThan(0)
    })
})

describe("a path that is neither", () => {
    it("names the parameter and what it wants", async () => {
        // The thing ENOTDIR never said. A caller who cannot tell "wrong kind
        // of path" from "no such path" cannot correct either one.
        const failure = await fs.query({ cwd: join(root, "nope"), glob: "*" }).catch((e: Error) => e)

        expect(failure).toBeInstanceOf(Error)
        expect((failure as Error).message).toContain("cwd")
        expect((failure as Error).message).toContain("DIRECTORY")
        expect((failure as Error).message).toContain(join(root, "nope"))
    })
})

/**
 * read() and list() are the same confusion in the other two directions, and
 * both answered with raw errno text that named no fix.
 */
describe("read and list point at each other", () => {
    it("tells a read of a directory to use list", async () => {
        const failure = await fs.read(join(root, "src")).catch((e: Error) => e)

        expect((failure as Error).message).toContain("is a directory")
        expect((failure as Error).message).toContain("fs.list()")
    })

    it("tells a list of a file to use read", async () => {
        const failure = await fs.list(join(root, "src", "map.ts")).catch((e: Error) => e)

        expect((failure as Error).message).toContain("is a file")
        expect((failure as Error).message).toContain("fs.read()")
    })

    it("leaves a genuinely missing file alone", async () => {
        // "It is not there" needs no redirection — suggesting another tool
        // would be worse than the plain answer.
        const failure = await fs.read(join(root, "missing.ts")).catch((e: Error) => e)

        expect((failure as Error).message).toContain("ENOENT")
    })

    it("still reads and lists correctly", async () => {
        expect(await fs.read(join(root, "src", "other.ts"))).toContain("degraded")
        expect((await fs.list(join(root, "src"))).sort()).toEqual(["map.ts", "other.ts"])
    })
})
