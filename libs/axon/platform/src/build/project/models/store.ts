import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises"
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
    /** Absolute path to the file — what a cognet ultimately receives. */
    path: string
    sha256: string
    bytes: number
}

function defaultRoot(): string {
    return process.env.AXON_MODELS_DIR ?? join(homedir(), ".axon", "models")
}

export function ModelStore(opts: ModelStoreOpts = {}) {
    const root = opts.root ?? defaultRoot()
    /** specifier → { sha256, file }. A hint for unpinned models; see resolved(). */
    const indexPath = join(root, "index.json")

    /** Where a given hash's file lives. Pure — no I/O. */
    function pathFor(sha256: string, filename: string): string {
        return join(root, sha256, filename)
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
            const index = await fsx.readJson<Record<string, { sha256: string; file: string }>>(indexPath)
            const hit = index?.[specifier]
            if (!hit) return null

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
        async list(): Promise<{ specifier: string; path: string; sha256: string; bytes: number }[]> {
            const index = await fsx.readJson<Record<string, { sha256: string; file: string }>>(indexPath)
            if (!index) return []

            const found: { specifier: string; path: string; sha256: string; bytes: number }[] = []
            for (const [specifier, hit] of Object.entries(index)) {
                const path = pathFor(hit.sha256, hit.file)
                if (!fsx.isFile(path)) continue
                found.push({ specifier, path, sha256: hit.sha256, bytes: (await stat(path)).size })
            }
            return found
        },

        /** Record what a specifier resolved to, so the next run can skip the network. */
        async remember(specifier: string, stored: StoredModel, filename: string): Promise<void> {
            const index = (await fsx.readJson<Record<string, { sha256: string; file: string }>>(indexPath)) ?? {}
            index[specifier] = { sha256: stored.sha256, file: filename }
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
    }
}

export type ModelStoreT = ReturnType<typeof ModelStore>
