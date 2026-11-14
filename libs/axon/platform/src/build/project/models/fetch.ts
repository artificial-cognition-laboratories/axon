import { stat } from "node:fs/promises"
import { err } from "@arcforge/err"
import { onnx } from "./onnx"
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

/** Own acquisition of files and complete repositories. Construction does no I/O. */
export function Fetch(opts: { store: ModelStoreT; fetch?: ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>) }) {
    return {
        file: (model: ParsedModel, input: Omit<FetchOpts, "store" | "fetch"> = {}) => fetchModel(model, { ...opts, ...input }),
        manifest: (input: { repo: { host: "hf"; repo: string; rev: string; key: string }; files: string[]; primary: string; options?: Omit<FetchOpts, "store" | "fetch">; traits?: ModelTraitsInput }) =>
            fetchManifest(input.repo, input.files, input.primary, { ...opts, ...input.options }, input.traits),
    }
}

/** The hash HF claims for this file, when it can be known before downloading. */
async function expectedHash(model: ParsedModel, signal?: AbortSignal, doFetch: ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>) = fetch): Promise<string | null> {
    if (model.sha256) return model.sha256

    try {
        const response = await doFetch(downloadUrl(model), { method: "HEAD", redirect: "follow", signal: signal })
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
    } catch (cause) {
        if (signal?.aborted) throw cause
        // A HEAD that fails is not itself a failure — the GET below reports
        // the real problem with a better message.
        return null
    }
}

export type FetchOpts = {
    fetch?: ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>)
    signal?: AbortSignal
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
async function fetchModel(model: ParsedModel, opts: FetchOpts): Promise<StoredModel> {
    const doFetch = opts.fetch ?? fetch
    opts.signal?.throwIfAborted()
    // A pinned model is answerable from its own address, with no network.
    const cached = await opts.store.find(model)
    if (cached) {
        if (opts.remember !== false) {
            await opts.store.remember(specifierOf(model), cached, basenameOf(model), { traits: model.traits, signal: opts.signal })
        }
        return cached
    }

    // An unpinned one needs the index: without a declared hash there is no
    // address to look up, and a registry may not publish a usable one either.
    // Skipping this made every prepare re-download every model.
    const remembered = await opts.store.resolved(specifierOf(model))
    if (remembered) {
        if (model.traits) await opts.store.describe(specifierOf(model), model.traits)
        return remembered
    }

    const expected = await expectedHash(model, opts.signal, doFetch)
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
        if (opts.remember !== false) {
            await opts.store.remember(specifierOf(model), hit, basenameOf(model), { traits: model.traits, signal: opts.signal })
        }
        return hit
    }

    opts.onDownload?.(model)

    let response: Response
    try {
        response = await doFetch(downloadUrl(model), { redirect: "follow", signal: opts.signal })
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

    if (!response.body) throw err("MODEL_FETCH_FAILED", { detail: `${model.key}: model response has no body` })
    const length = response.headers.get("content-length")
    const total = length === null ? null : Number(length)
    opts.onProgress?.({ model: model, received: 0, total: total })
    const stored = await opts.store.receive({
        filename: basenameOf(model),
        body: response.body,
        ...(expected ? { expected: expected } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
        progress: received => opts.onProgress?.({ model: model, received: received, total: total }),
    })
    opts.signal?.throwIfAborted()
    if (opts.remember !== false) {
        await opts.store.remember(specifierOf(model), stored, basenameOf(model), { traits: model.traits, signal: opts.signal })
    }
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
export type ModelTraitsInput = {
    capability?: string
    type?: "generate" | "transform" | "stream"
    in?: string[]
    out?: string[]
}

async function discoverManifest(repo: { host: "hf"; repo: string; rev: string }): Promise<{ files: string[]; primary: string }> {
    const response = await fetch(`https://huggingface.co/api/models/${repo.repo}`)
    if (!response.ok) {
        throw err("MODEL_FETCH_FAILED", {
            detail: `${repo.repo}: could not read repository manifest (${response.status})`,
            context: { repo: repo.repo, status: response.status },
        })
    }

    const raw = await response.json() as { siblings?: Array<{ rfilename?: string }> }
    const names = (raw.siblings ?? [])
        .map(entry => entry.rfilename)
        .filter((name): name is string => typeof name === "string")
        .filter(name => !name.startsWith(".git/") && !/^readme|^license|^\.gitignore$/i.test(name))

    const runnable = names.filter(name => /\.(onnx|gguf|safetensors|pt|pth)$/i.test(name))
    const primary = runnable.find(name => /(^|\/)model[^/]*\.onnx$/i.test(name))
        ?? runnable.find(name => /decoder|encoder/i.test(name))
        ?? runnable[0]

    if (!primary) {
        throw err("MODEL_NO_SINGLE_WEIGHT", {
            detail: `${repo.repo}: set declaration found no runnable model files`,
            context: { repo: repo.repo },
        })
    }

    // An ONNX repository holds the graph once per quantisation; a runtime
    // loads one. Take that one set, not the repository.
    return onnx.plan(names) ?? { files: names, primary }
}

async function fetchManifest(
    repo: { host: "hf"; repo: string; rev: string; key: string },
    files: string[],
    primary: string,
    opts: FetchOpts,
    traits?: ModelTraitsInput,
): Promise<StoredModel> {
    const specifier = `${repo.host}:${repo.repo}@${repo.rev}`
    const manifest = files.length > 0
        ? { files, primary }
        : await discoverManifest(repo)
    const resolvedFiles = manifest.files
    const resolvedPrimary = manifest.primary

    const cached = await opts.store.resolved(specifier)
    if (cached) return cached

    const collected: { file: { path: string; sha256: string; bytes: number }; stored: StoredModel }[] = []

    for (const path of resolvedFiles) {
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

    opts.signal?.throwIfAborted()
    await opts.store.rememberSet(specifier, collected, resolvedPrimary, traits)

    const resolved = await opts.store.resolved(specifier)
    if (!resolved) {
        // Written and immediately unreadable is a fault in the store, not a
        // user error, and it must not read as "this model is not cached".
        throw err("MODEL_FETCH_FAILED", {
            detail: `${repo.repo}: the set was written but could not be read back`,
            context: { repo: repo.repo, files: resolvedFiles.length },
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


/** The index key: what was declared, including the revision it was declared at. */
function specifierOf(model: ParsedModel): string {
    return `${model.host}:${model.repo}@${model.rev}/${model.file}`
}
