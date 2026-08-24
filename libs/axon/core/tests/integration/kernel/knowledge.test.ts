import { Axon as AxonRuntime } from "@axon/core"
import { KERNEL_ABI_VERSION } from "@arcforge/types"
import type { AxonKnowledge, KernelAbi } from "@arcforge/types"
import { defineCognet } from "@arcforge/cognet"
import { mkdtemp, mkdir, writeFile, readFile, symlink, readdir, stat } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

/**
 * The knowledge store, exercised through the live ABI.
 *
 * Driven through a cognet rather than the runtime's public handle, because
 * that is the only surface `knowledge` exists on: the kernel handle exposes
 * what the BODY needs (stream, request, run), while the ABI is what a brain
 * holds. Testing through the body would have proved nothing about the
 * contract a cognet author actually writes against.
 *
 * Every assertion goes through the captured ABI and verifies via observables
 * — returned values, the session log, files on disk. Nothing reaches into
 * Knowledge()'s internals, so the layout stays free to move underneath.
 */

/** A brain that does nothing but hand its ABI back, so a test can drive it. */
function ProbeCognet(capture: (abi: KernelAbi) => void) {
    return defineCognet({
        name: "probe",
        version: "1.0.0",
        abi: KERNEL_ABI_VERSION,
        mode: { kind: "invocation" },
        load(abi) {
            capture(abi)
        },
        async wake() {},
    })
}

/** An agent root with data/knowledge/ seeded from a name → content map. */
async function agent(entries: Record<string, string> = {}): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), "axon-knowledge-"))
    for (const [name, content] of Object.entries(entries)) {
        const file = path.join(root, "data", "knowledge", name)
        await mkdir(path.dirname(file), { recursive: true })
        await writeFile(file, content)
    }
    return root
}

/**
 * Boot a runtime over `root` and hand back the ABI its brain was given.
 *
 * Knowledge is DISCOVERED BY THE BUILD and carried on the blueprint, so the
 * harness scans first — the same order the real pipeline uses. Passing
 * entries the runtime never saw would test a shape nothing produces.
 * Discovery itself (walking, frontmatter, symlinks, namespacing) belongs to
 * the platform scanner's own tests; what these assert is what the ABI does
 * with what it was given.
 */
async function boot(root: string, entries?: AxonKnowledge[]) {
    let abi: KernelAbi | null = null
    const runtime = await AxonRuntime({
        blueprint: {
            cognet: { name: "probe", version: "1.0.0", abi: KERNEL_ABI_VERSION, definition: ProbeCognet(a => { abi = a }) },
            knowledge: entries ?? await scan(root),
            paths: { root, data: path.join(root, ".agent", "data") },
        },
    })
    if (!abi) throw new Error("probe cognet never received its ABI")
    return { runtime, knowledge: abi.knowledge, session: runtime.session }
}

/**
 * Stand in for the build's scanner: walk the agent's own store into blueprint
 * entries. Kept minimal on purpose — the real scanner is tested where it
 * lives, and duplicating its behaviour here would let the two drift while
 * both stayed green.
 */
async function scan(root: string): Promise<AxonKnowledge[]> {
    const store = path.join(root, "data", "knowledge")
    const entries: AxonKnowledge[] = []

    async function walk(dir: string, prefix: string): Promise<void> {
        let items
        try {
            items = await readdir(dir, { withFileTypes: true })
        } catch {
            return
        }
        for (const item of items) {
            if (item.name.startsWith(".")) continue
            const file = path.join(dir, item.name)
            const name = prefix ? `${prefix}/${item.name}` : item.name
            const info = await stat(file).catch(() => null)
            if (!info) continue
            if (info.isDirectory()) {
                await walk(file, name)
                continue
            }
            const content = await readFile(file, "utf-8").catch(() => "")
            entries.push({ name, description: describeFrontmatter(content), size: info.size, path: file, origin: "agent" })
        }
    }

    await walk(store, "")
    return entries
}

function describeFrontmatter(content: string): string {
    if (!content.startsWith("---")) return ""
    const end = content.indexOf("\n---", 3)
    if (end < 0) return ""
    let title = ""
    for (const line of content.slice(3, end).split("\n")) {
        const match = /^\s*(description|title)\s*:\s*(.+?)\s*$/.exec(line)
        if (!match) continue
        const value = match[2]!.replace(/^["'](.*)["']$/, "$1")
        if (match[1] === "description") return value
        title ||= value
    }
    return title
}

describe("kernel knowledge — catalogue", () => {
    it("returns an empty catalogue when the agent authored no knowledge directory", async () => {
        // The common case: most agents never author one. An empty list keeps
        // the caller from having to distinguish "none" from "absent".
        const { runtime, knowledge } = await boot(await agent())

        expect(await knowledge.list()).toEqual([])

        await runtime.shutdown()
    })

    it("catalogues entries by name with their declared description", async () => {
        const content = "---\ndescription: How to extend the Axon terminal.\n---\n\nBody text."
        const root = await agent({ "terminal.md": content })
        const { runtime, knowledge } = await boot(root)

        // The path is part of the entry: knowledge spans several packages, so
        // a name cannot be joined to one root any more.
        expect(await knowledge.list()).toEqual([
            {
                name: "terminal.md",
                description: "How to extend the Axon terminal.",
                size: Buffer.byteLength(content),
                path: path.join(root, "data", "knowledge", "terminal.md"),
            },
        ])

        await runtime.shutdown()
    })

    it("reports an empty description for material that declares none", async () => {
        // A .json corpus or a plain note is legitimate knowledge. Empty
        // string, never undefined — a renderer must not have to branch.
        const { runtime, knowledge } = await boot(await agent({ "weather.json": '{"city":"chicago"}' }))

        const [entry] = await knowledge.list()
        expect(entry?.description).toBe("")

        await runtime.shutdown()
    })

    it("addresses nested material by name, and never lists the folders themselves", async () => {
        // A folder is organisation, not knowledge — a cognet that saw one
        // would have to decide what reading it means.
        const { runtime, knowledge } = await boot(await agent({
            "axon/terminal.md": "terminal",
            "axon/agents.md": "agents",
            "root.md": "root",
        }))

        expect((await knowledge.list()).map(e => e.name))
            .toEqual(["axon/agents.md", "axon/terminal.md", "root.md"])

        await runtime.shutdown()
    })

    it("orders the catalogue by name so a capped render is a stable prefix", async () => {
        const { runtime, knowledge } = await boot(await agent({ "c.md": "c", "a.md": "a", "b.md": "b" }))

        expect((await knowledge.list()).map(e => e.name)).toEqual(["a.md", "b.md", "c.md"])
        expect((await knowledge.list({ limit: 2 })).map(e => e.name)).toEqual(["a.md", "b.md"])

        await runtime.shutdown()
    })

    it("filters on the caller's own predicate, over both name and description", async () => {
        const { runtime, knowledge } = await boot(await agent({
            "terminal.md": "---\ndescription: Extending the TUI.\n---\n",
            "deploy.md": "---\ndescription: Shipping to the cloud.\n---\n",
        }))
        expect((await knowledge.list({ match: "terminal" })).map(e => e.name)).toEqual(["terminal.md"])
        expect((await knowledge.list({ match: "cloud" })).map(e => e.name)).toEqual(["deploy.md"])
        // Case-insensitive: a brain rendering a user's words into a filter
        // should not have to normalise them first.
        expect((await knowledge.list({ match: "TUI" })).map(e => e.name)).toEqual(["terminal.md"])
        expect(await knowledge.list({ match: "nothing-matches-this" })).toEqual([])

        await runtime.shutdown()
    })

    it("omits dotfiles so editor and VCS noise never reaches the catalogue", async () => {
        const { runtime, knowledge } = await boot(await agent({ ".gitkeep": "", "real.md": "real" }))

        expect((await knowledge.list()).map(e => e.name)).toEqual(["real.md"])

        await runtime.shutdown()
    })
})

describe("kernel knowledge — reading", () => {
    it("reads an entry's content back by name", async () => {
        const { runtime, knowledge } = await boot(await agent({ "notes.md": "the body" }))

        expect(await knowledge.read("notes.md")).toBe("the body")

        await runtime.shutdown()
    })

    it("throws on a missing entry rather than returning empty", async () => {
        // Not a cache: a brain reading something the catalogue advertised has
        // hit a real inconsistency, and silence would hide it.
        const { runtime, knowledge } = await boot(await agent())

        expect(knowledge.read("absent.md")).rejects.toThrow(/KNOWLEDGE_NOT_FOUND|absent\.md/)

        await runtime.shutdown()
    })
})

describe("kernel knowledge — writing", () => {
    it("creates an entry that is immediately readable and catalogued", async () => {
        const root = await agent()
        const { runtime, knowledge } = await boot(root)

        await knowledge.write("learned.md", "---\ndescription: Something learned.\n---\n\nDetail.")

        expect(await knowledge.read("learned.md")).toContain("Detail.")
        expect((await knowledge.list()).map(e => e.description)).toEqual(["Something learned."])
        // Durable on disk under the agent root — this is the record, not a
        // process-local buffer.
        expect(await readFile(path.join(root, "data", "knowledge", "learned.md"), "utf-8")).toContain("Detail.")

        await runtime.shutdown()
    })

    it("creates parent directories so a brain can organise its own memory", async () => {
        const { runtime, knowledge } = await boot(await agent())

        await knowledge.write("memory/2026/august.md", "what happened")

        expect(await knowledge.read("memory/2026/august.md")).toBe("what happened")

        await runtime.shutdown()
    })

    it("replaces an existing entry in place", async () => {
        const { runtime, knowledge } = await boot(await agent({ "notes.md": "before" }))

        await knowledge.write("notes.md", "after")

        expect(await knowledge.read("notes.md")).toBe("after")
        expect(await knowledge.list()).toHaveLength(1)

        await runtime.shutdown()
    })

    it("leaves no temp files behind after a write", async () => {
        // temp+rename is how the write stays atomic; a leaked .tmp would show
        // up in the catalogue as phantom knowledge.
        const { runtime, knowledge } = await boot(await agent())

        await knowledge.write("notes.md", "content")

        expect((await knowledge.list()).map(e => e.name)).toEqual(["notes.md"])

        await runtime.shutdown()
    })
})

describe("kernel knowledge — removal", () => {
    it("removes an entry from the store and the catalogue", async () => {
        const root = await agent({ "stale.md": "old" })
        const { runtime, knowledge } = await boot(root)

        await knowledge.remove("stale.md")

        expect(await knowledge.list()).toEqual([])
        expect(existsSync(path.join(root, "data", "knowledge", "stale.md"))).toBe(false)

        await runtime.shutdown()
    })

    it("is idempotent — removing what is already gone is the outcome the caller wanted", async () => {
        const { runtime, knowledge } = await boot(await agent())

        await knowledge.remove("never-existed.md")

        await runtime.shutdown()
    })
})

describe("kernel knowledge — confinement", () => {
    it("refuses a name that escapes the store, on every verb", async () => {
        // Enforced, not trusted: the cognet is not adversarial, but a boundary
        // that only holds for well-behaved code is not a boundary.
        const { runtime, knowledge } = await boot(await agent())

        expect(knowledge.read("../../.env")).rejects.toThrow(/KNOWLEDGE_ESCAPE|outside the store/)
        expect(knowledge.write("../escaped.md", "nope")).rejects.toThrow(/KNOWLEDGE_ESCAPE|outside the store/)
        expect(knowledge.remove("../../.env")).rejects.toThrow(/KNOWLEDGE_ESCAPE|outside the store/)

        await runtime.shutdown()
    })

    it("does not write outside the agent root when a name tries to traverse", async () => {
        const root = await agent()
        const { runtime, knowledge } = await boot(root)

        await knowledge.write("../escaped.md", "nope").catch(() => {})

        expect(existsSync(path.join(root, "..", "escaped.md"))).toBe(false)

        await runtime.shutdown()
    })
})

describe("kernel knowledge — tracing", () => {
    it("commits a durable record of every mutation, naming the entry", async () => {
        // "The agent modified its own long-term memory" is exactly the fact
        // you want weeks later when behaviour drifts.
        const { runtime, knowledge, session } = await boot(await agent())

        await knowledge.write("learned.md", "body")
        await knowledge.remove("learned.md")

        const mutations = session.kernelLog.filter(e => e.type.startsWith("cognet:knowledge:"))
        expect(mutations.map(e => e.type)).toEqual(["cognet:knowledge:write", "cognet:knowledge:remove"])
        expect(mutations.every(e => (e.data as { name: string }).name === "learned.md")).toBe(true)

        await runtime.shutdown()
    })

    it("records the name but never the content", async () => {
        // The log records that memory changed, not a second copy of it.
        const { runtime, knowledge, session } = await boot(await agent())

        await knowledge.write("secret.md", "SENTINEL_CONTENT_VALUE")

        const written = session.kernelLog.find(e => e.type === "cognet:knowledge:write")
        expect(JSON.stringify(written?.data)).not.toContain("SENTINEL_CONTENT_VALUE")

        await runtime.shutdown()
    })

    it("does not record a mutation for a read", async () => {
        const { runtime, knowledge, session } = await boot(await agent({ "notes.md": "body" }))

        await knowledge.read("notes.md")
        await knowledge.list()

        expect(session.kernelLog.filter(e => e.type.startsWith("cognet:knowledge:"))).toEqual([])

        await runtime.shutdown()
    })
})

describe("kernel knowledge — frontmatter", () => {
    it("prefers description over title when both are declared", async () => {
        const { runtime, knowledge } = await boot(await agent({
            "a.md": "---\ntitle: The Loop\ndescription: loop, tick, phase and the world clock.\n---\n",
        }))

        expect((await knowledge.list())[0]?.description).toBe("loop, tick, phase and the world clock.")

        await runtime.shutdown()
    })

    it("falls back to title, so an uneven corpus still catalogues usefully", async () => {
        // Real corpora are uneven — the Axon docs carry a title on nearly
        // every file and a description on a sixth of them. Reading only the
        // richer field would leave most entries as bare filenames.
        const { runtime, knowledge } = await boot(await agent({ "a.md": "---\ntitle: Agent\n---\n" }))

        expect((await knowledge.list())[0]?.description).toBe("Agent")

        await runtime.shutdown()
    })

    it("strips surrounding quotes from either field", async () => {
        const { runtime, knowledge } = await boot(await agent({ "a.md": `---\ntitle: "Quoted Title"\n---\n` }))

        expect((await knowledge.list())[0]?.description).toBe("Quoted Title")

        await runtime.shutdown()
    })
})

describe("kernel knowledge — mounted material", () => {
    it("walks a symlinked directory instead of choking on it", async () => {
        // readdir reports a SYMLINK as a symlink, never as what it points at,
        // so trusting the dirent walked a linked directory as if it were a
        // file and blew up with EISDIR. Symlinking an existing corpus in is
        // the obvious way to mount one, so this has to work.
        const source = await mkdtemp(path.join(tmpdir(), "axon-corpus-"))
        await writeFile(path.join(source, "guide.md"), "---\ntitle: Guide\n---\n")

        const root = await agent({ "local.md": "local" })
        await symlink(source, path.join(root, "data", "knowledge", "docs"))
        const { runtime, knowledge } = await boot(root)

        const names = (await knowledge.list()).map(e => e.name)
        expect(names).toContain("docs/guide.md")
        expect(names).toContain("local.md")
        expect(await knowledge.read("docs/guide.md")).toContain("Guide")

        await runtime.shutdown()
    })

    it("skips a broken link rather than failing the whole catalogue", async () => {
        // One bad entry must not cost the model every other one.
        const root = await agent({ "real.md": "real" })
        await symlink(path.join(root, "nowhere"), path.join(root, "data", "knowledge", "dangling"))
        const { runtime, knowledge } = await boot(root)

        expect((await knowledge.list()).map(e => e.name)).toEqual(["real.md"])

        await runtime.shutdown()
    })
})

describe("kernel knowledge — module material", () => {
    /** A module-contributed entry, as the build would record it. */
    async function moduleEntry(name: string, content: string): Promise<AxonKnowledge> {
        const pkg = await mkdtemp(path.join(tmpdir(), "axon-module-"))
        const file = path.join(pkg, "data", "knowledge", name.split("/").pop()!)
        await mkdir(path.dirname(file), { recursive: true })
        await writeFile(file, content)
        return {
            name,
            description: describeFrontmatter(content),
            size: Buffer.byteLength(content),
            path: file,
            origin: "module",
            module: "@axon/docs",
        }
    }

    it("catalogues module material alongside the agent's own", async () => {
        // The whole point: knowledge travels as a package, so one corpus can
        // be installed into many agents without being copied into any.
        const entry = await moduleEntry("@axon/docs/agent.md", "---\ntitle: Agents\n---\n")
        const { runtime, knowledge } = await boot(await agent({ "mine.md": "mine" }), [
            { name: "mine.md", description: "", size: 4, path: "", origin: "agent" },
            entry,
        ])

        expect((await knowledge.list()).map(e => e.name)).toEqual(["@axon/docs/agent.md", "mine.md"])

        await runtime.shutdown()
    })

    it("reads module material from wherever its package lives", async () => {
        const entry = await moduleEntry("@axon/docs/agent.md", "the module's own body")
        const { runtime, knowledge } = await boot(await agent(), [entry])

        expect(await knowledge.read("@axon/docs/agent.md")).toBe("the module's own body")

        await runtime.shutdown()
    })

    it("refuses to write module material rather than losing it on the next install", async () => {
        // A module's files live under node_modules. A write that succeeded
        // here would vanish at the next install, which is worse than failing.
        const entry = await moduleEntry("@axon/docs/agent.md", "original")
        const { runtime, knowledge } = await boot(await agent(), [entry])

        expect(knowledge.write("@axon/docs/agent.md", "edited")).rejects.toThrow(/KNOWLEDGE_READONLY|cannot be written/)
        expect(knowledge.remove("@axon/docs/agent.md")).rejects.toThrow(/KNOWLEDGE_READONLY|cannot be removed/)
        expect(await knowledge.read("@axon/docs/agent.md")).toBe("original")

        await runtime.shutdown()
    })

    it("keeps a namespaced module entry distinct from the agent's own same-named file", async () => {
        // Two corpora on one subject is the normal case; the namespace is what
        // stops one silently shadowing the other.
        const entry = await moduleEntry("@axon/docs/agent.md", "module copy")
        const { runtime, knowledge } = await boot(await agent({ "agent.md": "agent copy" }), [
            { name: "agent.md", description: "", size: 10, path: "", origin: "agent" },
            entry,
        ])

        expect(await knowledge.read("@axon/docs/agent.md")).toBe("module copy")
        expect((await knowledge.list()).map(e => e.name)).toHaveLength(2)

        await runtime.shutdown()
    })
})

describe("kernel knowledge — writes are visible immediately", () => {
    it("lists and reads back an entry written this session", async () => {
        // The catalogue is the read path's index. An agent that wrote a memory
        // and could not see it until the next build would have a store that
        // silently forgets — precisely the self-managed-memory case.
        const { runtime, knowledge } = await boot(await agent())

        await knowledge.write("learned.md", "---\ndescription: Something learned.\n---\n")

        expect((await knowledge.list()).map(e => e.name)).toEqual(["learned.md"])
        expect((await knowledge.list())[0]?.description).toBe("Something learned.")
        expect(await knowledge.read("learned.md")).toContain("Something learned.")

        await runtime.shutdown()
    })

    it("drops a removed entry from the catalogue", async () => {
        const { runtime, knowledge } = await boot(await agent({ "stale.md": "old" }))

        await knowledge.remove("stale.md")

        expect(await knowledge.list()).toEqual([])

        await runtime.shutdown()
    })
})
