import { readdir, readFile } from "node:fs/promises"
import { join, relative, sep } from "node:path"

/**
 * Files — the working tree under one root, as a searchable list of paths.
 *
 * Owns exactly one sentence: list the paths under `root` that a person might
 * want to reference. It is the source behind the TUI's `@` palette and knows
 * nothing about palettes, modes or drafts.
 *
 * Two decisions shape it:
 *
 * **The tree is indexed once, not walked per keystroke.** A palette filters on
 * every character; a recursive readdir per character over a real repo is not
 * something a 100ms render budget survives. One walk produces a flat list and
 * every subsequent query is an in-memory filter — the same reasoning as the
 * registry catalogue, for the same reason.
 *
 * **Staleness is resolved explicitly, never on a timer.** The index is walked
 * once and held until someone calls `invalidate()`. Not an fs.watch, which
 * costs descriptors over a large tree for the entire session to serve a list
 * the user opens occasionally; and not a TTL, because the consumer calls
 * `ensure()` from inside a reactive computed — anything that can spontaneously
 * decide to re-walk turns that into a render loop. A path created seconds ago
 * and missing from the list is recoverable (the user types it); a pegged core
 * is not.
 */
export function Files(opts: FilesOpts) {
    const root = opts.root
    const maxEntries = opts.maxEntries ?? 200_000
    const maxDepth = opts.maxDepth ?? 12

    let index: FileEntry[] | null = null
    let truncated = false
    // The in-flight walk, so N keystrokes arriving before the first resolves
    // share one traversal instead of starting N of them.
    let walking: Promise<FileEntry[]> | null = null

    /**
     * NOT `async`. The in-flight promise has to be published SYNCHRONOUSLY, in
     * the same tick as the check that found none — an `async` body suspends at
     * its first `await` (reading .gitignore) with `walking` still null, and
     * every caller arriving in that window starts a walk of its own. On the
     * TUI's path those callers are consecutive renders, so the "shared" walk
     * became one full traversal per keystroke.
     */
    function ensure(): Promise<FileEntry[]> {
        if (index !== null) return Promise.resolve(index)
        if (walking) return walking

        walking = ignoresFor(root)
            .then(ignore => walk(root, ignore, maxEntries, maxDepth))
            .then(result => {
                index = result.entries
                truncated = result.truncated
                return result.entries
            })
            .finally(() => {
                walking = null
            })

        return walking
    }

    return {
        /** The root every entry's path is relative to. */
        root: root,

        /**
         * True when the last walk stopped at `maxEntries` or `maxDepth` and the
         * index is therefore INCOMPLETE. Exposed because a truncated list is
         * indistinguishable from a complete one by inspection, and a consumer
         * showing "no matches" over a partial index would be stating something
         * it does not know.
         */
        get truncated(): boolean { return truncated },

        /**
         * Every indexed entry, walking the tree on first call. Callers filter
         * it themselves — matching is a UI concern (the TUI ranks with its own
         * chunk matcher) and baking one strategy in here would force every
         * consumer to accept it.
         */
        list: ensure,

        /**
         * The immediate children of one directory, relative to root ("" is the
         * root itself). Served off the same index — browsing and searching are
         * two views of one walk, not two mechanisms.
         */
        async children(dir: string): Promise<FileEntry[]> {
            const entries = await ensure()
            const prefix = dir === "" ? "" : dir.endsWith("/") ? dir : `${dir}/`
            return entries.filter(entry => {
                if (!entry.path.startsWith(prefix)) return false
                const rest = entry.path.slice(prefix.length)
                return rest.length > 0 && !rest.includes("/")
            })
        },

        /** Drop the index so the next call re-walks — after a checkout, a scaffold, a clone. */
        invalidate(): void {
            index = null
            truncated = false
        },
    }
}

export type FilesT = ReturnType<typeof Files>

export type FilesOpts = {
    /** The directory every path is listed relative to. */
    root: string
    /**
     * Hard cap on indexed entries — a guard against a root that turns out to be
     * `/` or a home directory, where an unbounded walk would hang the caller
     * with no way to tell it apart from a slow disk.
     *
     * Set high enough that a real project never reaches it: hitting the cap
     * means paths are MISSING from the list, and a palette that silently omits
     * the file you are searching for is worse than one that takes another
     * hundred milliseconds. This repo (29G, ~54k tracked entries) indexes in
     * ~300ms — the cap is for pathological roots, not large ones. When it does
     * bite, `truncated` says so rather than leaving the caller to guess.
     */
    maxEntries?: number
    /**
     * How deep the walk descends. Bounds the walk by SHAPE where `maxEntries`
     * bounds it by output — the two are not substitutes, since a level's queue
     * is built in full before the entry cap is next consulted.
     */
    maxDepth?: number
}

export type FileEntry = {
    /** Path relative to the root, POSIX-separated — what a user types and what an agent receives. */
    path: string
    /** The final segment, for matching a name without its directories. */
    name: string
    /** Directories are listed too: they are navigable, and referencing one is meaningful. */
    directory: boolean
}

/**
 * Always skipped, regardless of what .gitignore says.
 *
 * Two classes, one rule: directories holding code nobody wrote here and nobody
 * references by hand. `.git` is machine state; the rest are dependency trees
 * that dominate both the walk and every result list while being the last thing
 * a person means by `@`.
 *
 * Skipped unconditionally rather than left to .gitignore because they are
 * frequently NOT ignored — a vendored `.venv` in this repo contributed 29k of
 * 83k entries and every one of the deepest paths in the tree. Relying on the
 * ignore file to catch them means the walk's cost depends on someone else's
 * hygiene.
 */
const ALWAYS_SKIP = new Set([
    ".git",
    "node_modules",
    // Python: virtualenvs (both conventional names) and bytecode caches.
    ".venv",
    "venv",
    "__pycache__",
    // Rust, Go, Java/Kotlin — build and dependency output.
    "target",
    "vendor",
    ".gradle",
])

/**
 * The root's own ignore rules, read once per walk.
 *
 * Deliberately a SUBSET of gitignore syntax. Three forms are honoured, and they
 * are the ones that actually do the work of keeping a walk small:
 *
 *     dist          a bare name, ignored at any depth
 *     **&#47;dist       the same thing written explicitly — the DOMINANT idiom
 *     /apps/x/dist  anchored to the root
 *
 * `**&#47;name` is stripped to a bare name rather than discarded. Treating it as an
 * unsupported "glob" is what made this useless on a real repo: 48 of the 49
 * patterns in this one are written that way, so discarding them meant walking
 * every `dist`, `.output` and `target` in a 29G tree — the whole cost the
 * ignore file existed to avoid.
 *
 * Patterns with an INTERIOR wildcard (`*.log`, `build-*`) are still skipped:
 * matching those needs real glob semantics, and the cost of missing one is a
 * palette row, not a hung walk. Negations (`!`) and nested per-directory ignore
 * files are also unsupported. If this ever needs to be exact, take a
 * dependency — do not grow this function.
 */
async function ignoresFor(root: string): Promise<Ignore> {
    const names = new Set<string>()
    const anchored = new Set<string>()

    let text: string
    try {
        text = await readFile(join(root, ".gitignore"), "utf8")
    } catch {
        // No .gitignore is the normal case for most directories, not a failure.
        // Any other read error (permissions) means the same thing here: walk
        // with the built-in skips alone. Nothing downstream is wrong without it.
        return { names, anchored }
    }

    for (const raw of text.split("\n")) {
        const line = raw.trim()
        if (!line || line.startsWith("#") || line.startsWith("!")) continue

        // Strip a trailing "/**" ("node_modules/**") and a trailing slash
        // ("dist/") — both mean the directory itself.
        let pattern = line.replace(/\/\*\*$/, "").replace(/\/$/, "")
        // A leading "**/" means "at any depth", which is precisely what a bare
        // name already means here.
        const anyDepth = pattern.startsWith("**/")
        if (anyDepth) pattern = pattern.slice(3)

        if (!pattern) continue
        if (pattern.includes("*") || pattern.includes("?")) continue // interior wildcards need real globbing

        if (!anyDepth && pattern.includes("/")) anchored.add(pattern.replace(/^\//, ""))
        else names.add(pattern)
    }

    return { names, anchored }
}

type Ignore = {
    /** Bare names ignored at any depth ("dist", ".env"). */
    names: Set<string>
    /** Root-relative paths ("apps/foo/dist"). */
    anchored: Set<string>
}

/**
 * Breadth-first so the cap, when it bites, keeps the shallow paths — the ones
 * a person is most likely to be reaching for. A depth-first walk that hit the
 * limit would return one deep branch and nothing else.
 *
 * Two properties this walk must have, both learned the hard way:
 *
 * **It yields.** A tree this size is tens of thousands of `readdir` calls, and
 * awaiting them in one uninterrupted chain starves the caller's event loop —
 * in the TUI that means the render loop stops and the whole terminal appears
 * hung behind a "reading working tree..." row. Handing control back every
 * YIELD_EVERY directories keeps the app responsive while it indexes.
 *
 * **It is depth-capped.** `maxEntries` alone is not a bound on TIME: the queue
 * for one level is built before the cap is next checked, so a pathological tree
 * can do enormous work between checks. A depth limit bounds the walk by shape
 * rather than by output, and nothing a person references by hand lives 12
 * directories down.
 */
async function walk(root: string, ignore: Ignore, maxEntries: number, maxDepth: number): Promise<WalkResult> {
    const out: FileEntry[] = []
    let queue: string[] = [""]
    let depth = 0
    let sinceYield = 0

    while (queue.length > 0 && out.length < maxEntries && depth <= maxDepth) {
        const next: string[] = []

        for (const dir of queue) {
            if (out.length >= maxEntries) break

            // Give the event loop a turn. setTimeout rather than a resolved
            // promise: a microtask yield still blocks rendering, because the
            // whole microtask queue drains before the loop moves on.
            if (++sinceYield >= YIELD_EVERY) {
                sinceYield = 0
                await new Promise(resolve => setTimeout(resolve, 0))
            }

            let dirents
            try {
                dirents = await readdir(join(root, dir), { withFileTypes: true })
            } catch {
                // Unreadable directory (permissions, a symlink to nowhere, a
                // race with something deleting it mid-walk). Skipping it is
                // correct and local: the rest of the tree is still listable,
                // and failing the whole walk over one directory would make the
                // palette unusable because of a directory nobody asked about.
                continue
            }

            for (const dirent of dirents) {
                if (out.length >= maxEntries) break
                if (ALWAYS_SKIP.has(dirent.name)) continue
                if (ignore.names.has(dirent.name)) continue

                const path = dir === "" ? dirent.name : `${dir}/${dirent.name}`
                if (ignore.anchored.has(path)) continue

                // A symlinked directory is not descended: a link pointing at an
                // ancestor makes the walk non-terminating, and there is no
                // cheap way to tell that case from a benign one. The link
                // itself is still listed, so it remains referenceable.
                const directory = dirent.isDirectory()
                out.push({ path: path, name: dirent.name, directory: directory })
                if (directory && dirent.isSymbolicLink() === false) next.push(path)
            }
        }

        queue = next
        depth++
    }

    // Either bound stopping the walk with work left means the index is partial:
    // the entry cap bit, or a level remained unvisited when the depth cap did.
    return {
        entries: out,
        truncated: out.length >= maxEntries || queue.length > 0,
    }
}

type WalkResult = {
    entries: FileEntry[]
    /** The walk stopped at a bound rather than at the end of the tree. */
    truncated: boolean
}

/** Directories read between event-loop yields. Small enough to stay responsive, large enough not to pay a timer per directory. */
const YIELD_EVERY = 50

/** Normalize an absolute path under `root` to the relative, POSIX form used by entries. */
export function toEntryPath(root: string, absolute: string): string {
    return relative(root, absolute).split(sep).join("/")
}
