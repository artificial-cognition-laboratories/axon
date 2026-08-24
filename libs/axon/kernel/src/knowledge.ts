import { existsSync } from "node:fs"
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { err } from "@arcforge/err"
import type { AxonKnowledge, KernelKnowledge, KnowledgeEntry } from "@arcforge/types"

type KnowledgeOpts = {
    /** The agent root — <root>/data/knowledge/ is the writable store. */
    root: string
    /**
     * Every knowledge file this agent can reach, discovered at build time —
     * its own plus each installed module's, already namespaced.
     *
     * Carried rather than walked because a module's corpus lives in its own
     * package: enumerating one directory would have meant copying every
     * module's material into the agent, which forks it on the first update
     * and duplicates megabytes per agent.
     */
    entries: readonly AxonKnowledge[]
    /** Committed by the kernel on every mutation; the cognet never writes its own record. */
    onMutate?: (event: "write" | "remove", name: string) => void
}

/**
 * The writable store's layout authority — the ONE place that knows an
 * agent's own knowledge lives at <agent>/data/knowledge/.
 *
 * Only the agent's own material has a layout here. A module's files are
 * addressed by the absolute path the build recorded, because they live
 * wherever the package manager put them.
 */
function storeRoot(root: string): string {
    return path.join(root, "data", "knowledge")
}

/**
 * Resolve a name to a path inside the agent's OWN store, refusing anything
 * that leaves it.
 *
 * A name is an IDENTIFIER, not a path — "axon/terminal.md" is a name whose
 * separators happen to nest. Traversal is refused rather than sanitised
 * because a caller that wrote "../../.env" meant something, and quietly
 * rewriting it to a different file is worse than failing.
 *
 * Enforced, not trusted: the cognet is not adversarial, but a boundary that
 * only holds for well-behaved code is not a boundary.
 */
function resolveOwn(root: string, name: string): string {
    const store = storeRoot(root)
    const target = path.resolve(store, name)
    const contained = target === store || target.startsWith(store + path.sep)
    if (!contained) {
        throw err("KNOWLEDGE_ESCAPE", { detail: `knowledge name "${name}" resolves outside the store`, context: { name } })
    }
    return target
}

/**
 * Pull a one-line summary out of a written entry's frontmatter.
 *
 * A near-duplicate of the build scanner's parse, and deliberately so: this
 * one runs against content already in memory for a single file the agent
 * just wrote, while the scanner reads 4KB heads off disk across a whole
 * corpus. Sharing would mean the kernel importing the build, which inverts
 * the dependency — ring 0 must not depend on the CLI that produced its
 * blueprint. Both are ten lines and neither is load-bearing on the other:
 * a drift costs one entry a description until the next scan corrects it.
 */
function describe(content: string): string {
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

/**
 * Knowledge — the cognet's long-term store, mediated.
 *
 * A leaf that owns one concern completely: reading and writing knowledge by
 * NAME. It holds no cognition — no ranking, no retrieval strategy, no notion
 * of relevance. `match` filters on metadata the caller supplied; everything
 * else a brain wants (full-text search, embeddings, a symbolic index) it
 * builds itself, because choosing how a mind recalls is memory policy and the
 * kernel is forbidden from holding one.
 *
 * READS span every source; WRITES only ever touch the agent's own store.
 * A module's files live under node_modules and the next install would
 * destroy anything written there — so a write addressed at module material
 * fails loudly rather than succeeding and disappearing later.
 *
 * See KernelKnowledge in @arcforge/types for the full doctrine.
 */
export function Knowledge(opts: KnowledgeOpts): KernelKnowledge {
    /**
     * Name → the build's record of it, plus anything written since.
     *
     * Live rather than frozen at construction because the catalogue is the
     * read path's index: an agent that wrote a memory and could not list or
     * read it back until the next scan would have a store that silently
     * forgets, which is precisely the self-managed-memory case this exists
     * for. Writes register here; removals drop out.
     */
    const byName = new Map(opts.entries.map(entry => [entry.name, entry]))

    return {
        async list(listOpts) {
            // Ordered before filtering and before the cap, so `limit` yields a
            // stable prefix of one total order rather than whichever order the
            // scan happened to produce.
            const entries: KnowledgeEntry[] = [...byName.values()]
                .map(entry => ({ name: entry.name, description: entry.description, size: entry.size, path: entry.path }))
                .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

            const match = listOpts?.match?.toLowerCase()
            const filtered = match
                ? entries.filter(entry => entry.name.toLowerCase().includes(match) || entry.description.toLowerCase().includes(match))
                : entries

            return listOpts?.limit === undefined ? filtered : filtered.slice(0, listOpts.limit)
        },

        async read(name) {
            // The catalogue is the index: a name it knows resolves to the path
            // the build recorded, wherever that package lives. A name it does
            // not know may still be something the agent wrote since the scan,
            // so its own store is checked before giving up.
            const known = byName.get(name)
            const file = known ? known.path : resolveOwn(opts.root, name)

            if (!existsSync(file)) {
                throw err("KNOWLEDGE_NOT_FOUND", { detail: `no knowledge entry named "${name}"`, context: { name } })
            }
            return readFile(file, "utf-8")
        },

        async write(name, content) {
            const known = byName.get(name)
            if (known?.origin === "module") {
                throw err("KNOWLEDGE_READONLY", {
                    detail: `"${name}" belongs to module ${known.module} and cannot be written`,
                    context: { name, module: known.module ?? "" },
                })
            }

            const file = resolveOwn(opts.root, name)
            await mkdir(path.dirname(file), { recursive: true })

            // Atomic, like store.set() — but for a different reason. The kv is
            // a cache and a torn write there costs a rebuild; knowledge is the
            // record, so a half-written entry is real loss. temp + rename means
            // a kill mid-write leaves the previous content intact.
            const tmp = `${file}.${crypto.randomUUID().slice(0, 8)}.tmp`
            await writeFile(tmp, content)
            await rename(tmp, file)

            // Register it so the catalogue reflects the write immediately. The
            // build rescans on the next prepare and supersedes this, but a
            // brain must be able to list and read back what it just wrote
            // within the same session.
            byName.set(name, {
                name,
                description: describe(content),
                size: Buffer.byteLength(content),
                path: file,
                origin: "agent",
            })

            opts.onMutate?.("write", name)
        },

        async remove(name) {
            const known = byName.get(name)
            if (known?.origin === "module") {
                throw err("KNOWLEDGE_READONLY", {
                    detail: `"${name}" belongs to module ${known.module} and cannot be removed`,
                    context: { name, module: known.module ?? "" },
                })
            }

            const file = resolveOwn(opts.root, name)
            // Idempotent: a brain pruning its own memory should not have to
            // check first, and "already gone" is the outcome it wanted.
            if (!existsSync(file)) {
                byName.delete(name)
                return
            }
            await unlink(file)
            byName.delete(name)

            opts.onMutate?.("remove", name)
        },
    }
}

export type KnowledgeT = ReturnType<typeof Knowledge>
