import { createHash } from "node:crypto"
import { link, mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { err } from "@arcforge/err"
import { fsx } from "../../../utils/fs"
import { basenameOf, type ParsedModel } from "./specifier"

/**
 * ModelStore — the machine's cache of model weights.
 *
 * ```
 * ~/.axon/models/<sha256>/<basename>
 * ```
 *
 * CONTENT-ADDRESSED, and machine-wide rather than per-agent. Ten agents
 * running the same 150MB whisper share one copy, and the hash in the path is
 * what makes that safe: two files at the same address are the same bytes, so
 * dedup and verification are the same fact.
 *
 * `AXON_MODELS_DIR` overrides the location. That seam is what lets a
 * deployment image bake weights in at build time without the store, the
 * kernel or the cognet knowing anything changed — the cognet only ever sees
 * an absolute path.
 */

type ModelStoreOpts = {
    /** Override the cache root. Tests point this at a scratch dir. */
    root?: string
}

export type StoredModel = {
    /**
     * Absolute path — what a cognet ultimately receives.
     *
     * A FILE for a single-file weight, a DIRECTORY for a set. That difference
     * is deliberately not a type distinction: llama.cpp takes a `.gguf` path
     * and transformers.js takes a directory, so what a runtime wants is
     * already a path either way. Widening this to a union would push a branch
     * into every consumer to express something no consumer needs to know.
     */
    path: string
    /**
     * The content hash. For a set, the PRIMARY weight's hash.
     *
     * Still an address of real bytes, so `has()` and the pinned-ref fast path
     * keep working unchanged. It is not an address of the whole set — nothing
     * needs one, because a set is addressed by its specifier.
     */
    sha256: string
    /** Bytes on disk. For a set, the sum of every file in it. */
    bytes: number
    /** Absolute path to the weight inside a set. Absent for a single file. */
    primary?: string
}

/** One file inside a model set, at its path RELATIVE to the repository root. */
export type ModelFile = {
    /** e.g. `onnx/model.onnx`, `config.json`. Never flattened — see `tree`. */
    path: string
    sha256: string
    bytes: number
}

/**
 * What a cached weight is, as the registry described it when it was fetched.
 *
 * Optional throughout: a weight fetched before this existed, or by a path that
 * never knew, has none — and absent is an honest answer where "other" was a
 * claim.
 */
export type ModelTraits = {
    capability?: string
    type?: string
    in?: string[]
    out?: string[]
}

/**
 * One cached weight that is a single file.
 *
 * Unchanged from the first version of this index, and deliberately so: a GGUF
 * quantisation genuinely IS one file, and making it carry a one-element
 * manifest would be ceremony around the common case.
 */
type SingleEntry = {
    sha256: string
    file: string
    traits?: ModelTraits
}

/**
 * One cached weight that is a set of files.
 *
 * An ONNX repository is not a weight, it is a weight plus the tokeniser,
 * preprocessor and generation config needed to turn a person's input into
 * tensors. transformers.js reads those from a DIRECTORY laid out as the
 * repository lays them out, which is why `files[].path` keeps its
 * repository-relative shape rather than being flattened to a basename.
 */
type SetEntry = {
    /** Directory name under `root/trees` holding the materialised layout. */
    tree: string
    /** Every file, repository-relative. The manifest — this is the record. */
    files: ModelFile[]
    /** Which of `files` is the weight, for a runtime that wants one path. */
    primary: string
    traits?: ModelTraits
}

type Entry = SingleEntry | SetEntry

/** Discriminates the two shapes. A manifest has files; a single file has one name. */
function isSet(entry: Entry): entry is SetEntry {
    return Array.isArray((entry as SetEntry).files)
}

/** The on-disk index: specifier → where the bytes are, and what they are. */
type IndexEntry = Record<string, Entry>

function defaultRoot(): string {
    return process.env.AXON_MODELS_DIR ?? join(homedir(), ".axon", "models")
}

export function ModelStore(opts: ModelStoreOpts = {}) {
    const root = opts.root ?? defaultRoot()
    /** specifier → { sha256, file, traits? }. A hint for unpinned models; see resolved(). */
    const indexPath = join(root, "index.json")

    /** Where a given hash's file lives. Pure — no I/O. */
    function pathFor(sha256: string, filename: string): string {
        return join(root, sha256, filename)
    }

    /**
     * Where a set's materialised layout lives.
     *
     * Separate from the content-addressed blobs, and under a directory of its
     * own so a stray tree can never be mistaken for a hash. Trees hold
     * HARDLINKS to the blobs: same bytes, no second copy, and removing a tree
     * cannot damage a weight another specifier still names.
     */
    function treeFor(name: string): string {
        return join(root, "trees", name)
    }

    /**
     * A stable directory name for a specifier.
     *
     * Hashed rather than sanitised, because a specifier carries `/`, `@` and
     * `:` and every escaping scheme that flattens those is a scheme two
     * different specifiers can collide in. Truncated because this names a
     * directory, not bytes — it needs to be unique, not tamper-evident.
     */
    function treeNameFor(specifier: string): string {
        return createHash("sha256").update(specifier).digest("hex").slice(0, 32)
    }

    return {
        get root() {
            return root
        },

        pathFor,

        /**
         * The stored file for this model, or null when absent.
         *
         * Only answerable when the ref carries a hash — the address IS the
         * hash, so without one there is nothing to look up. An unpinned model
         * resolves through the fetch path, which learns the hash from the
         * registry first.
         */
        async find(model: ParsedModel): Promise<StoredModel | null> {
            if (!model.sha256) return null
            const path = pathFor(model.sha256, basenameOf(model))
            if (!fsx.isFile(path)) return null
            const info = await stat(path)
            return { path, sha256: model.sha256, bytes: info.size }
        },

        /** True when these exact bytes are already cached. */
        has(sha256: string, filename: string): boolean {
            return fsx.isFile(pathFor(sha256, filename))
        },

        /**
         * What a previous fetch resolved this specifier to, if anything.
         *
         * Content-addressing alone cannot answer for an UNPINNED model: the
         * address is the hash, and without a declared hash there is nothing
         * to look up. Registries do not reliably publish one either — HF's
         * plain etag is a git blob sha, which is not the hash of the bytes it
         * serves.
         *
         * So a small index maps specifier → hash, written after the first
         * successful verified fetch. Without it, every unpinned model
         * re-downloads on every prepare, which for a 150MB whisper is
         * minutes of nothing.
         *
         * The index is a CACHE HINT, never authority: the file it points at
         * is still content-addressed, so a corrupted or missing entry costs a
         * refetch and cannot produce wrong bytes.
         */
        async resolved(specifier: string): Promise<StoredModel | null> {
            const index = await fsx.readJson<IndexEntry>(indexPath)
            const hit = index?.[specifier]
            if (!hit) return null

            if (isSet(hit)) {
                const tree = treeFor(hit.tree)
                const primary = join(tree, hit.primary)
                /*
                 * The PRIMARY file is the liveness test for the whole set.
                 *
                 * Checking all forty would be forty stats on a path a caller
                 * takes hundreds of times, and it would not buy correctness:
                 * a set missing a config fails at load with the file named,
                 * which is a better error than this could produce. The weight
                 * being gone is the case that means "not cached".
                 */
                if (!fsx.isFile(primary)) return null
                const weight = hit.files.find(file => file.path === hit.primary)
                return {
                    path: tree,
                    sha256: weight?.sha256 ?? "",
                    bytes: hit.files.reduce((sum, file) => sum + file.bytes, 0),
                    primary: primary,
                }
            }

            const path = pathFor(hit.sha256, hit.file)
            if (!fsx.isFile(path)) return null

            const info = await stat(path)
            return { path, sha256: hit.sha256, bytes: info.size }
        },

        /**
         * Every specifier this machine has fetched, with where it landed.
         *
         * The index already maps specifier → address for `resolved()`; this
         * enumerates it, which is the question a surface listing "what is on
         * this machine" asks. Derived from the same file rather than a second
         * record, so a listing cannot disagree with a lookup.
         *
         * A specifier whose FILE has gone is omitted rather than reported:
         * the index is a cache hint and the bytes are the fact, so an entry
         * pointing at nothing is stale rather than a model.
         */
        async list(): Promise<{
            specifier: string
            path: string
            sha256: string
            bytes: number
            primary?: string
            traits?: ModelTraits
        }[]> {
            const index = await fsx.readJson<IndexEntry>(indexPath)
            if (!index) return []

            const found: {
                specifier: string
                path: string
                sha256: string
                bytes: number
                primary?: string
                traits?: ModelTraits
            }[] = []

            for (const [specifier, hit] of Object.entries(index)) {
                if (isSet(hit)) {
                    const tree = treeFor(hit.tree)
                    const primary = join(tree, hit.primary)
                    if (!fsx.isFile(primary)) continue
                    const weight = hit.files.find(file => file.path === hit.primary)
                    found.push({
                        specifier,
                        path: tree,
                        sha256: weight?.sha256 ?? "",
                        // The manifest's own sum, not a walk of the tree. The
                        // sizes were measured when the bytes were verified;
                        // re-stating forty files per listing would be slower
                        // and no more true.
                        bytes: hit.files.reduce((sum, file) => sum + file.bytes, 0),
                        primary: primary,
                        ...(hit.traits ? { traits: hit.traits } : {}),
                    })
                    continue
                }

                const path = pathFor(hit.sha256, hit.file)
                if (!fsx.isFile(path)) continue
                found.push({
                    specifier,
                    path,
                    sha256: hit.sha256,
                    bytes: (await stat(path)).size,
                    ...(hit.traits ? { traits: hit.traits } : {}),
                })
            }
            return found
        },

        /**
         * Record what a cached weight IS, beside where it landed.
         *
         * ── Why the store holds this ────────────────────────────────────────
         *
         * A file on disk declares no task: `model.onnx` could be a
         * transcriber, an embedder or a face detector, and enumerating the
         * cache could only ever report "other". The registry knows — it is in
         * the listing that was open when the download started — and that
         * knowledge was being thrown away the moment the bytes landed.
         *
         * So it is written down. Here rather than in a sidecar of its own,
         * because the index is already the one record of "what has this
         * machine fetched" and a second file would be a second answer to the
         * same question, free to disagree.
         *
         * Merged, never replaced: the caller supplies what it knows and the
         * rest survives.
         */
        async describe(specifier: string, traits: ModelTraits): Promise<void> {
            const index = (await fsx.readJson<IndexEntry>(indexPath)) ?? {}
            const hit = index[specifier]
            // Describing something the store has never seen would write an
            // entry with no bytes behind it, which `list()` would then skip
            // forever. Silent because a describe racing a removal is ordinary.
            if (!hit) return
            index[specifier] = { ...hit, traits: { ...hit.traits, ...traits } }
            await mkdir(root, { recursive: true })
            await Bun.write(indexPath, JSON.stringify(index, null, 4))
        },

        /**
         * Record a specifier that resolved to a SET of files, and materialise
         * its layout.
         *
         * ── Why a tree of hardlinks ─────────────────────────────────────────
         *
         * Two requirements pull in opposite directions. Content-addressing is
         * what lets ten agents share one weight, and `remove()`'s whole
         * correctness argument rests on it. transformers.js, meanwhile, wants
         * a DIRECTORY laid out as the repository lays it out — `config.json`
         * beside `onnx/model.onnx` — because that is how it finds the
         * tokeniser and preprocessor it needs.
         *
         * Hardlinks satisfy both. The blob stays the one copy of those bytes
         * at its hash; the tree is a second name for the same inode. No extra
         * disk, and `rm -rf` of a tree decrements a link count rather than
         * destroying a weight some other specifier still points at.
         *
         * A copy is the fallback, and only for `EXDEV` — a link across
         * filesystems. That cannot happen with the default root, but a
         * relocated `AXON_MODELS_DIR` beside a bind-mounted blob store could
         * produce it, and failing the whole fetch over a layout detail would
         * be the wrong trade.
         *
         * ── The manifest is written LAST ────────────────────────────────────
         *
         * Files are linked first, index second. A crash in between leaves an
         * orphaned tree nothing references, which the next fetch overwrites;
         * the reverse order would leave the index claiming a model whose files
         * are not there, and `resolved()` would hand a caller a path into
         * nothing.
         */
        async rememberSet(
            specifier: string,
            files: { file: ModelFile; stored: StoredModel }[],
            primary: string,
        ): Promise<void> {
            const name = treeNameFor(specifier)
            const tree = treeFor(name)

            // Replaced wholesale rather than merged: a refetch may resolve a
            // different variant, and a tree holding both would hand
            // transformers.js two models in one directory.
            await rm(tree, { recursive: true, force: true })

            for (const entry of files) {
                const target = join(tree, entry.file.path)
                await mkdir(join(target, ".."), { recursive: true })
                try {
                    await link(entry.stored.path, target)
                } catch (cause) {
                    if ((cause as { code?: string }).code !== "EXDEV") throw cause
                    await Bun.write(target, Bun.file(entry.stored.path))
                }
            }

            const index = (await fsx.readJson<IndexEntry>(indexPath)) ?? {}
            const previous = index[specifier]
            index[specifier] = {
                tree: name,
                files: files.map(entry => entry.file),
                primary: primary,
                // Traits describe the MODEL, not the bytes — a refetch must
                // not forget what it is.
                ...(previous?.traits ? { traits: previous.traits } : {}),
            }
            await mkdir(root, { recursive: true })
            await Bun.write(indexPath, JSON.stringify(index, null, 4))
        },

        /** Record what a specifier resolved to, so the next run can skip the network. */
        async remember(specifier: string, stored: StoredModel, filename: string): Promise<void> {
            const index = (await fsx.readJson<IndexEntry>(indexPath)) ?? {}
            // Traits are preserved across a re-fetch: they describe the MODEL,
            // not the bytes, and re-downloading the same weight must not
            // forget what it is.
            index[specifier] = { ...index[specifier], sha256: stored.sha256, file: filename }
            await mkdir(root, { recursive: true })
            await Bun.write(indexPath, JSON.stringify(index, null, 4))
        },

        /**
         * Commit downloaded bytes to the store.
         *
         * Hashes first, then writes to a temp path, then renames into place.
         * A partial file must NEVER sit at a valid address: rename is atomic
         * within a filesystem, so a reader either sees the whole file or no
         * file. Without that, an interrupted 150MB download leaves a
         * truncated model that every later run trusts forever — and
         * content-addressing would be a lie, since the path would claim a
         * hash the contents do not have.
         *
         * `expected` is the caller's claim about what these bytes should be
         * (from a pin, or from the registry's own metadata). A mismatch
         * throws rather than storing: caching corrupt weights is worse than
         * failing to cache.
         */
        async put(filename: string, data: Uint8Array, expected?: string): Promise<StoredModel> {
            const sha256 = createHash("sha256").update(data).digest("hex")

            if (expected && expected !== sha256) {
                throw err("MODEL_HASH_MISMATCH", {
                    detail:
                        `${filename}: expected sha256 ${expected} but the downloaded bytes hash to ${sha256} `
                        + `— the upstream file changed, or the download was corrupted`,
                    context: { filename, expected, actual: sha256 },
                })
            }

            const target = pathFor(sha256, filename)
            if (fsx.isFile(target)) {
                // Already cached by another agent, or a previous run. Same
                // hash means the same bytes, so there is nothing to do.
                return { path: target, sha256, bytes: data.byteLength }
            }

            const staging = await mkdtemp(join(tmpdir(), "axon-model-"))
            try {
                const temp = join(staging, filename)
                await Bun.write(temp, data)
                await mkdir(join(target, ".."), { recursive: true })
                await rename(temp, target)
            } catch (cause) {
                // A cross-device rename fails (EXDEV) when tmp and the store
                // are on different filesystems — copy is the honest fallback,
                // and Bun.write to the final path is still preferable to
                // leaving nothing.
                await mkdir(join(target, ".."), { recursive: true })
                await Bun.write(target, data)
                void cause
            } finally {
                await rm(staging, { recursive: true, force: true })
            }

            return { path: target, sha256, bytes: data.byteLength }
        },

        /**
         * Forget a specifier, and delete its bytes when nothing else wants them.
         *
         * ── The index is the owner, the file is shared ──────────────────────
         *
         * The store is content-addressed, so two specifiers that resolved to
         * the same bytes name ONE file — which is the whole reason ten agents
         * can hold a weight without ten copies on disk. Deleting the file
         * because one specifier no longer wants it would pull the bytes out
         * from under every other name for them.
         *
         * So the entry always goes and the file goes only when no surviving
         * entry references that hash. A hash still referenced leaves a
         * perfectly good file behind, which is correct rather than a leak.
         *
         * ── Order matters ───────────────────────────────────────────────────
         *
         * The index is written BEFORE the file is unlinked. `list()` already
         * skips entries whose file is missing, so an index that still names a
         * deleted file is merely stale; a file deleted while the index still
         * claims it would be reported as cached by anything reading the index
         * directly. Crash between the two and the next `list()` is still
         * right.
         *
         * Returns false when the specifier was not cached — a caller asking to
         * remove something absent has not failed, and should not be told it
         * has.
         */
        async remove(specifier: string): Promise<boolean> {
            const index = await fsx.readJson<IndexEntry>(indexPath)
            const hit = index?.[specifier]
            if (!index || !hit) return false

            delete index[specifier]
            await mkdir(root, { recursive: true })
            await Bun.write(indexPath, JSON.stringify(index, null, 4))

            /*
             * Every hash the survivors still reference, from BOTH shapes.
             *
             * A set holds forty hashes and a single file holds one, and a blob
             * may well be referenced by one of each — the same `model.onnx`
             * fetched once on its own and once as part of a repository is one
             * file at one address. Gathering the survivors into a set and
             * asking it per hash is the only version of this that stays right
             * as shapes are added; a check written per shape would have to be
             * edited every time one is.
             */
            const live = new Set<string>()
            for (const entry of Object.values(index)) {
                if (isSet(entry)) for (const file of entry.files) live.add(file.sha256)
                else live.add(entry.sha256)
            }

            // The tree goes unconditionally: it belongs to this specifier
            // alone, and its hardlinks are references the blobs below have
            // already been counted without.
            if (isSet(hit)) await rm(treeFor(hit.tree), { recursive: true, force: true })

            const held = isSet(hit) ? hit.files.map(file => file.sha256) : [hit.sha256]
            for (const sha256 of new Set(held)) {
                if (live.has(sha256)) continue
                // The hash directory, not just the file: a hash addresses
                // exactly one set of bytes, so with the last reference gone
                // the directory holding them has nothing left to hold.
                await rm(join(root, sha256), { recursive: true, force: true })
            }
            return true
        },
    }
}

export type ModelStoreT = ReturnType<typeof ModelStore>
