import type { ManifestT } from "./manifest"
import type { TreeT } from "./tree"

/**
 * Reconcile — bring the manifest and the installed tree into agreement with
 * what the project actually declares.
 *
 * `axon prepare` is the RECONCILING command, the way `npm install` is: it
 * reads the declaration, notices where reality disagrees, and fixes it. The
 * reproducible counterpart is `--frozen`, which asserts agreement instead of
 * creating it (see `frozen` below).
 *
 * Prepare used to do neither. It asked one question — "is anything missing?" —
 * and every dependency bug of the last day fell out of that:
 *
 *   - a package present at the wrong version passed as installed, because
 *     installed-ness was `existsSync(dir)`
 *   - a declared range that permitted a newer version never re-resolved, so a
 *     published fix could not reach an agent that already had the broken one
 *   - a cognet replaced in axon.config.ts left its predecessor declared
 *     forever, because only `file:` modules were ever pruned
 *   - "declared" short-circuited the install entirely, so a declared-but-
 *     deleted package produced an error telling the user to run the command
 *     that had just skipped it
 *
 * Each was a different symptom of the same missing step.
 */

export type ReconcileResult = {
    /** Dependencies Axon owns that are no longer declared — removed from package.json. */
    pruned: string[]
    /** True when the MANIFEST had to change. The tree's state is verify's answer. */
    changed: boolean
}

type ReconcileOpts = {
    manifest: ManifestT
    tree: TreeT
    /**
     * Every dependency Axon manages for this project, and the range each
     * should be declared at — the cognet plus registry modules.
     *
     * The map is authoritative in BOTH directions: a name present here is
     * declared, and an Axon-managed name absent from it is removed. Anything
     * not mentioned is the user's own dependency and is never touched.
     */
    managed: Record<string, string>
    /**
     * Names Axon has ever managed, used to decide what may be pruned.
     * Deliberately wider than `managed`: pruning has to recognise the cognet
     * an agent USED to declare, which by definition is not in the new map.
     */
    owned: (name: string) => boolean
    /**
     * Inspect without repairing. `--frozen` needs to know whether the project
     * is in agreement, and must not become the thing that puts it there —
     * a check that fixes what it finds can never fail.
     */
    dryRun?: boolean
}

/**
 * Compare declaration against reality. Pure inspection plus manifest repair —
 * it never installs, so a caller can report or gate on the result.
 */
export async function reconcile(opts: ReconcileOpts): Promise<ReconcileResult> {
    const { manifest, tree, managed, owned } = opts

    // ── 1. manifest ← declaration ────────────────────────────────────────
    const declared = await manifest.package.dependencies.all()

    const dead = Object.keys(declared).filter(name => owned(name) && !(name in managed))
    const pruned = dead.length === 0
        ? []
        : opts.dryRun ? dead : await manifest.package.dependencies.remove(dead)

    const additions: Record<string, string> = {}
    for (const [name, range] of Object.entries(managed)) {
        if (declared[name] !== range) additions[name] = range
    }
    const declarationChanged = Object.keys(additions).length === 0
        ? false
        : opts.dryRun ? true : await manifest.package.dependencies.set(additions)

    return {
        pruned,
        // Whether the MANIFEST had to change. Whether the TREE agrees with it
        // is `tree.verify()`'s answer — this used to compute both, and two
        // implementations of "is the installed tree right" is exactly how they
        // drift apart. Prepare asks each for its own half.
        changed: pruned.length > 0 || declarationChanged,
    }
}
