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
        const hit = {
            path: opts.store.pathFor(expected, basenameOf(model)),
            sha256: expected,
            bytes: 0,
        }
        await opts.store.remember(specifierOf(model), hit, basenameOf(model))
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

    const data = new Uint8Array(await response.arrayBuffer())
    // put() hashes and refuses a mismatch — verification lives at the write,
    // so nothing can reach the cache unverified by any path.
    const stored = await opts.store.put(basenameOf(model), data, expected ?? undefined)
    await opts.store.remember(specifierOf(model), stored, basenameOf(model))
    return stored
}

/** The index key: what was declared, including the revision it was declared at. */
function specifierOf(model: ParsedModel): string {
    return `${model.host}:${model.repo}@${model.rev}/${model.file}`
}
