import { mkdir, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { join } from "node:path"

/**
 * Write bundled tool source to a real file so it can be `import()`ed.
 *
 * ── Why a file at all ───────────────────────────────────────────────────────
 *
 * A `data:` URI module specifier hits an OS-level max-length ceiling well
 * below what a real tool file needs (the full fs module clears it easily) and
 * throws NameTooLong. A path has no such limit. The filename is the content
 * hash, so repeated loads of identical source — a reload, two agents sharing a
 * module — reuse one file instead of leaking one per call.
 *
 * ── Why NOT the OS temp directory ───────────────────────────────────────────
 *
 * This used to write to `join(tmpdir(), …)`, and `tmpdir()` reads `TMPDIR`.
 * The agent process is spawned with an environment BUILT FROM NOTHING (see
 * link/confined.ts `floorEnv`), and `TMPDIR` was never on the pass-through
 * list — so the host resolved one directory and the agent resolved another.
 *
 * On Linux that is invisible: `TMPDIR` is usually unset on both sides, so both
 * land on `/tmp` and it works by coincidence. On macOS the host has
 * `TMPDIR=/var/folders/…` while the agent has none, so the agent fell back to
 * `/tmp` — which is a symlink to `/private/tmp` — and the import failed with
 * "Cannot find module /private/tmp/…". The agent could not boot at all.
 *
 * The fix is not to add `TMPDIR` to the pass-through list. That reconnects the
 * agent to host state the process boundary deliberately severs, and leaves the
 * same trap for the next thing that reads an ambient variable. Instead the
 * scratch directory is one the agent OWNS and can derive without asking its
 * environment anything.
 *
 * ── Why the frame's cache room ──────────────────────────────────────────────
 *
 * `.agent/cache/` is documented as "regenerable, disposable", which is exactly
 * what materialized tool source is: content-hashed, rebuildable from the
 * blueprint, safe to delete at any moment. `.agent/data/` is the opposite —
 * "NOT regenerable — user history" — and it is committed by convention, so
 * writing scratch there would put build output in someone's repository.
 *
 * It also inherits the frame's existing lifecycle for free: `migrateFrame`
 * already discards and regenerates the cache room, so nothing new has to know
 * how to clean this up.
 */

/** The subdirectory of the frame's cache room that holds materialized tools. */
const TOOLS_DIR = "tools"

/**
 * The directory materialized tool source is written to, for one agent.
 *
 * Derived from the frame rather than from the environment: `dataPath` is
 * `<root>/.agent/data`, so its sibling `cache` is the agent's own scratch. The
 * caller passes the path it already holds on the blueprint — this function
 * asks the process for nothing.
 */
export function toolCacheDir(framePath: string): string {
    return join(framePath, TOOLS_DIR)
}

/**
 * Materialize one tool's bundled source, returning the path to import.
 *
 * `dir` is the agent's own scratch directory (see toolCacheDir). It is created
 * on demand — an agent that never loads a bundled tool never makes it.
 */
export async function materializeTool(dir: string, source: string): Promise<string> {
    await mkdir(dir, { recursive: true })
    const hash = createHash("sha256").update(source).digest("hex")
    const file = join(dir, `${hash}.ts`)
    await writeFile(file, source)
    return file
}
