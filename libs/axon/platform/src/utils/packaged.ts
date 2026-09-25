import { existsSync } from "node:fs"
import { resolve } from "node:path"

/**
 * Where the sibling executables live — workers, preloads, the update helper.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * Several modules spawn a subprocess from a file shipped beside the app, and
 * each resolved it the same way: `resolve(import.meta.dir, "worker.js")`,
 * falling back to the `.ts` source in the workspace. That worked because the
 * published CLI was ONE bundled `app.js`, so `import.meta.dir` was the package
 * root — a fact those call sites each stated in their own comment.
 *
 * Enabling `splitting` broke it. The entry is now a few hundred KB and the rest
 * lives in `chunks/`, so the code doing the resolving sits one directory deeper
 * and `import.meta.dir` points at `chunks/`. Every worker path missed, and the
 * failure was total rather than partial: `axon bench init` died with
 * `Module not found ".../chunks/worker.ts"`.
 *
 * ── Why a helper rather than six fixed call sites ───────────────────────────
 *
 * The six copies were already the bug: one shared assumption, restated in six
 * places, so nothing checked them together when the assumption changed. A
 * seventh worker added tomorrow would copy whichever neighbour it was written
 * next to. This is the one place that knows how the artifact is laid out, and
 * the layout can change again without hunting call sites.
 *
 * Deliberately NOT clever: it checks the directory the caller is in, then its
 * parent. That covers the single-file layout (worker beside the entry) and the
 * split layout (caller in `chunks/`, worker beside the entry one level up),
 * and it stops there — a search that walked further could find a stale worker
 * from an unrelated install, which is worse than failing.
 */
export function packagedPath(fromDir: string, name: string): string | null {
    const beside = resolve(fromDir, name)
    if (existsSync(beside)) return beside

    // Split layout: the caller is inside `chunks/`, the worker is beside the entry.
    const up = resolve(fromDir, "..", name)
    if (existsSync(up)) return up

    return null
}

/**
 * The packaged executable if it shipped, else the workspace source.
 *
 * The two-name shape is the norm at every call site: `worker.js` in a published
 * install, `worker.ts` when running from the repo. Returning the source path
 * unconditionally when nothing is packaged preserves the previous behaviour —
 * a missing file fails at spawn, where the error names the path.
 */
export function workerPath(fromDir: string, packagedName: string, sourceName: string): string {
    return packagedPath(fromDir, packagedName) ?? resolve(fromDir, sourceName)
}
