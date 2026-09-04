import { stat } from "node:fs/promises"
import { err } from "@arcforge/err"
import { basenameOf, downloadUrl, type ParsedModel } from "./specifier"
import type { ModelStoreT, StoredModel } from "./store"

/**
 * Fetching weights from Hugging Face.
 *
 * No SDK: the raw-file endpoint is a stable, documented URL and public repos
 * need no auth. A dependency on `@huggingface/hub` would buy a nicer API for
 * an operation that is one GET.
 *
 * VERIFICATION IS NOT OPTIONAL, but what can be verified varies:
 *
 * - a `sha256` pinned in the ref is authoritative and always checked
 * - LFS-backed files carry their real sha256 in `x-linked-etag`, which is
 *   the registry's own claim about the bytes and is checked before caching
 * - small non-LFS files carry only a git blob sha, which is NOT a content
 *   hash — so those are trust-on-first-use, hashed on arrival and remembered
 *
 * The difference is stated rather than hidden. An author who wants certainty
 * pins `sha256`, and then a changed upstream is an error instead of a
 * surprise. Whatever the source, the bytes are hashed before they are stored,
 * so the cache is content-addressed either way.
 */

/** The hash HF claims for this file, when it can be known before downloading. */
async function expectedHash(model: ParsedModel): Promise<string | null> {
    if (model.sha256) return model.sha256

    try {
        const response = await fetch(downloadUrl(model), { method: "HEAD", redirect: "follow" })
        if (!response.ok) return null

        // ONLY `x-linked-etag`. That header is the LFS object's sha256 — the
        // hash of the bytes actually served.
        //
        // The plain `etag` is NOT usable, even though it is also 64 hex
        // characters and looks identical. For non-LFS files it is the git
        // BLOB sha, which hashes `blob <len>\0<content>` rather than the
        // content, so it never matches and every download would be rejected
        // as corrupt. A hash that looks right and is wrong is worse than no
        // hash at all.
        const linked = response.headers.get("x-linked-etag")?.replace(/"/g, "").trim()
        return linked && /^[0-9a-f]{64}$/i.test(linked) ? linked.toLowerCase() : null
    } catch {
        // A HEAD that fails is not itself a failure — the GET below reports
        // the real problem with a better message.
        return null
    }
}

export type FetchOpts = {
    store: ModelStoreT
    /** Called before a download actually starts — nothing is emitted for a cache hit. */
    onDownload?: (model: ParsedModel) => void
    /**
     * Bytes received so far, and the total when the server declares one.
     *
     * `total` is null when the response carries no `Content-Length`, which
     * happens on chunked transfers — a surface must render that as "downloading"
     * rather than as a bar stuck at zero, so the absence is reported rather
     * than guessed at.
     *
     * Called on every chunk. A consumer that wants to throttle should do so;
     * throttling here would decide the cadence for every caller.
     */
    onProgress?: (progress: { model: ParsedModel; received: number; total: number | null }) => void

    /**
     * Record this file in the specifier index. Default true.
     *
     * False for a file fetched as a MEMBER of a set. The bytes still land in
     * the content-addressed store — that is what makes them shared and
     * verified — but the index maps "a model this machine has" to an address,
     * and a set's thirteen tokeniser and config files are not thirteen models.
     * Remembering them individually put `config.json` and `vocab.json` in the
     * machine's model list as though someone had downloaded them.
     *
     * The set writes ONE entry, for the set. That is the model.
     */
    remember?: boolean
}

/**
 * Resolve one model to a stored file, downloading only if needed.
 *
 * Fails loudly on every invalid state: an unreachable registry, a 404, a hash
 * that disagrees. A brain whose weights are missing is not degraded, it is
 * broken, and discovering that at first inference is far worse than at
 * prepare.
 */
export async function fetchModel(model: ParsedModel, opts: FetchOpts): Promise<StoredModel> {
    // A pinned model is answerable from its own address, with no network.
    const cached = await opts.store.find(model)
    if (cached) return cached

    // An unpinned one needs the index: without a declared hash there is no
    // address to look up, and a registry may not publish a usable one either.
    // Skipping this made every prepare re-download every model.
    const remembered = await opts.store.resolved(specifierOf(model))
    if (remembered) return remembered

    const expected = await expectedHash(model)
    if (expected && opts.store.has(expected, basenameOf(model))) {
        const path = opts.store.pathFor(expected, basenameOf(model))
        const hit = {
            path: path,
            sha256: expected,
            // Measured, not zero. Nothing read this until a manifest had to
            // sum its members' sizes to answer "how big is this model" — and
            // a set whose bytes came back short would be admitted into video
            // memory it does not fit in.
            bytes: (await stat(path)).size,
        }
        if (opts.remember !== false) await opts.store.remember(specifierOf(model), hit, basenameOf(model))
        return hit
    }

    opts.onDownload?.(model)

    let response: Response
    try {
        response = await fetch(downloadUrl(model), { redirect: "follow" })
    } catch (cause) {
        throw err("MODEL_FETCH_FAILED", {
            detail: `${model.key}: could not reach huggingface.co for ${model.repo}/${model.file}`,
            context: { key: model.key, repo: model.repo, file: model.file },
            cause,
        })
    }

    if (!response.ok) {
        throw err("MODEL_FETCH_FAILED", {
            detail:
                response.status === 404
                    ? `${model.key}: ${model.repo}/${model.file} not found at revision ${model.rev} `
                      + `— check the repo and file path`
                    : `${model.key}: huggingface.co answered ${response.status} for ${model.repo}/${model.file}`,
            context: { key: model.key, repo: model.repo, file: model.file, status: response.status },
        })
    }

    const data = opts.onProgress
        ? await readWithProgress(response, model, opts.onProgress)
        : new Uint8Array(await response.arrayBuffer())
    // put() hashes and refuses a mismatch — verification lives at the write,
    // so nothing can reach the cache unverified by any path.
    const stored = await opts.store.put(basenameOf(model), data, expected ?? undefined)
    if (opts.remember !== false) await opts.store.remember(specifierOf(model), stored, basenameOf(model))
    return stored
}

/**
 * Fetch a model that is a SET of files, and remember it as one.
 *
 * ── Why this is separate from fetchModel ────────────────────────────────────
 *
 * Not a loop around it. `fetchModel` answers "is this weight here, and if not
 * get it" and each of its three cache paths is about ONE file's address; a set
 * is cached or not as a whole, and a set half-fetched is not a model. So the
 * unit of the cache check, the unit of the index write and the unit of failure
 * all move up a level, and expressing that by calling the single-file function
 * n times would make each of those three things wrong in a different way.
 *
 * The single-file path is untouched. A GGUF genuinely is one file and pays
 * nothing for this.
 *
 * ── Order, and what a crash leaves behind ───────────────────────────────────
 *
 * Every file is fetched and verified before the manifest is written, and the
 * manifest is what makes the set cached. Interrupt this and the blobs are
 * already in the content-addressed store — so nothing is lost and the retry
 * skips what it has — while the index never claimed a model it did not have.
 *
 * The reverse order is the one that breaks: an index naming a set whose files
 * are missing hands a caller a directory path into nothing, which surfaces as
 * a runtime error about a config file rather than as "not downloaded".
 */
export async function fetchManifest(
    repo: { host: "hf"; repo: string; rev: string; key: string },
    files: string[],
    primary: string,
    opts: FetchOpts,
): Promise<StoredModel> {
    const specifier = `${repo.host}:${repo.repo}@${repo.rev}`

    const cached = await opts.store.resolved(specifier)
    if (cached) return cached

    const collected: { file: { path: string; sha256: string; bytes: number }; stored: StoredModel }[] = []

    for (const path of files) {
        // Reuses the whole single-file machine per member — hash expectation,
        // verification at the write, dedup against bytes already held. A set
        // sharing a config file with another set costs nothing twice.
        const member: ParsedModel = { key: `${repo.key}:${path}`, host: repo.host, repo: repo.repo, file: path, rev: repo.rev }
        const stored = await fetchModel(member, { ...opts, remember: false })
        collected.push({
            file: { path: path, sha256: stored.sha256, bytes: stored.bytes },
            stored: stored,
        })
    }

    await opts.store.rememberSet(specifier, collected, primary)

    const resolved = await opts.store.resolved(specifier)
    if (!resolved) {
        // Written and immediately unreadable is a fault in the store, not a
        // user error, and it must not read as "this model is not cached".
        throw err("MODEL_FETCH_FAILED", {
            detail: `${repo.repo}: the set was written but could not be read back`,
            context: { repo: repo.repo, files: files.length },
        })
    }
    return resolved
}

/**
 * Drain the body, reporting progress as it arrives.
 *
 * Only used when a caller asked for progress. `arrayBuffer()` remains the path
 * otherwise, because it is the runtime's own and there is no reason to
 * reimplement it for callers who are not watching.
 *
 * The chunks are joined once at the end rather than grown incrementally: a
 * multi-gigabyte weight reallocated on every chunk is how a download becomes
 * quadratic. `put()` still hashes the result, so nothing here weakens the
 * verification — this changes how the bytes arrive, not whether they are
 * checked.
 */
async function readWithProgress(
    response: Response,
    model: ParsedModel,
    onProgress: NonNullable<FetchOpts["onProgress"]>,
): Promise<Uint8Array> {
    const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10)
    const total = Number.isFinite(declared) && declared > 0 ? declared : null

    const body = response.body
    if (!body) return new Uint8Array(await response.arrayBuffer())

    const reader = body.getReader()
    const chunks: Uint8Array[] = []
    let received = 0

    onProgress({ model, received: 0, total })
    for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        chunks.push(value)
        received += value.byteLength
        onProgress({ model, received, total })
    }

    const data = new Uint8Array(received)
    let offset = 0
    for (const chunk of chunks) {
        data.set(chunk, offset)
        offset += chunk.byteLength
    }
    return data
}

/** The index key: what was declared, including the revision it was declared at. */
function specifierOf(model: ParsedModel): string {
    return `${model.host}:${model.repo}@${model.rev}/${model.file}`
}
