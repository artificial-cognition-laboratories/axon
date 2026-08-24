/**
 * The knowledge catalogue, as the model reads it.
 *
 * ── Why a tree and not a list ───────────────────────────────────────────────
 *
 * This block is resident: it is rendered into EVERY call, so its size is paid
 * once per turn for the life of the session. The first pass emitted a JSON
 * array of `{ name, description, path }` objects, which on a 194-file corpus
 * cost ~9,400 tokens — and only about a fifth of that was information. The rest
 * was JSON scaffolding repeated 194 times (`{`, `"name":`, `"description":`)
 * and the shared prefix of every name written out in full on every line.
 *
 * A tree says each path segment ONCE and lets indentation carry the rest, which
 * is the whole reason `tree(1)` reads better than `find(1)` for the same
 * information. Measured on the same corpus: ~2,000 tokens, a ~4.7x reduction,
 * with every description that carries meaning kept.
 *
 * The point of the block is orientation, not retrieval — the model needs to
 * know WHERE things are so it can name one and read it. A tree is the shape of
 * that question.
 */

/** One catalogued entry, as `kernel.knowledge.list()` returns it. */
export type KnowledgeItem = {
    name: string
    description: string
    path: string
}

/**
 * How deep the tree renders before collapsing.
 *
 * Generous on purpose. The corpus this was tuned against is ~4 levels, where a
 * cap changes nothing (2% at depth 4, and depth 3 costs only 2% more than no
 * cap at all) — so this is not a lever being pulled today. It exists because a
 * module is free to ship a 10-deep corpus, and an unbounded renderer would put
 * all of it in front of the model on every call with no ceiling.
 *
 * A collapsed directory still renders its name and a file count, so the model
 * knows material exists there and can ask for it by prefix. Silence would make
 * a deep corpus look empty, which is worse than a summary.
 */
const MAX_DEPTH = 4

/**
 * The filename that describes its own directory rather than a file beside it.
 *
 * Matched WITH its extension, because entry names are on-disk relative paths
 * (`tui/index.md`), not stripped slugs — the whole reason `.md.md` reached the
 * model was code here assuming otherwise.
 */
const INDEX = /^index\.[^.]+$/

type Node = {
    children: Map<string, Node>
    /** Present when this node is a real file rather than only a directory. */
    file?: KnowledgeItem
    /** The description to render — absent when it would only restate the name. */
    description?: string
    /**
     * True when `file` got here by folding an `index` onto this node.
     *
     * Tracked rather than inferred from "has children", because a directory
     * whose ONLY entry is its own index has none — `agent/src/tools/index.md`
     * folds onto `tools`, which is then childless. Inferring made the renderer
     * append an extension and name `tools.md`, a file that does not exist,
     * while the real page sat at `tools/index.md`. Seven entries in the
     * reference corpus are shaped exactly like that.
     */
    folded?: boolean
}

/**
 * Does this description tell the model anything the name has not?
 *
 * Compared with punctuation and case stripped, because the corpus is full of
 * frontmatter titles that are the filename typeset: `axon.md` → "axon",
 * `agent-dir.md` → ".agent/", `package.md` → "package.json". All of those pass
 * a naive `!==` and none of them earn a line.
 *
 * 68 of 194 entries in the reference corpus fail this check. Dropping them
 * loses nothing — the name is still right there.
 */
function informative(name: string, description: string): boolean {
    if (!description) return false
    // The extension is stripped before comparing: a name arrives as
    // `models.md` and its frontmatter title as "Models", which are the same
    // word once punctuation goes. Leaving `.md` in made every such pair look
    // distinct and kept 68 lines that say nothing.
    const stem = name.replace(/\.[^.]+$/, "")
    const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "")
    return normalize(description) !== normalize(stem)
}

/**
 * Build the tree, folding `index` onto the directory it documents.
 *
 * ── Why index folding is a correctness fix, not a saving ────────────────────
 *
 * `docs/identity/index.md` describes the `identity` SECTION. Rendered as a leaf
 * it becomes a child named `index` sitting beside its own siblings, described
 * as "Identity" — which reads as a file called index that is somehow the whole
 * topic. The tree says something false, and spends a line doing it.
 *
 * Folded, the description lands on the directory it was always about. The
 * clearest case is the root: the corpus's own `index.md` carries "A runtime and
 * toolkit for building, running, and deploying reliable AI agents." — a real
 * summary that was previously buried on a node rendered as `index`.
 *
 * The folded node keeps `file`, because the index file IS readable — it is the
 * section's own page. What changes is where it appears, not whether it exists.
 */
function build(items: readonly KnowledgeItem[]): Node {
    const root: Node = { children: new Map() }

    for (const item of items) {
        const segments = item.name.split("/").filter(Boolean)
        if (segments.length === 0) continue

        const isIndex = INDEX.test(segments.at(-1) ?? "")
        // An index file addresses its PARENT. A bare top-level `index` folds
        // onto the root itself, which has no name to restate.
        const target = isIndex ? segments.slice(0, -1) : segments

        let node = root
        for (const segment of target) {
            let next = node.children.get(segment)
            if (!next) {
                next = { children: new Map() }
                node.children.set(segment, next)
            }
            node = next
        }

        node.file = item
        if (isIndex) node.folded = true

        // Judged against the node's OWN name (the directory, for a folded
        // index), so `identity/index — "Identity"` is correctly dropped.
        const label = target.at(-1) ?? ""
        if (informative(label, item.description)) node.description = item.description
    }

    return root
}

/** Every file at or below this node — what a collapsed directory reports. */
function countFiles(node: Node): number {
    let total = node.file ? 1 : 0
    for (const child of node.children.values()) total += countFiles(child)
    return total
}

function renderNode(node: Node, prefix: string, depth: number, root: string | null): string[] {
    const lines: string[] = []
    const children = [...node.children.entries()]

    children.forEach(([name, child], index) => {
        const last = index === children.length - 1
        const branch = last ? "└── " : "├── "
        const childPrefix = prefix + (last ? "    " : "│   ")

        if (depth >= MAX_DEPTH && child.children.size > 0) {
            lines.push(`${prefix}${branch}${name}/  (${countFiles(child)} files)`)
            return
        }

        // A FILE carries its extension, a directory does not — exactly how
        // `tree(1)` distinguishes them, and what makes the path recoverable:
        // the stated root plus the segments walked to get here IS the file.
        //
        // Stating the extension on the name rather than repeating the filename
        // beside it costs 3 characters and says the name once. An entry whose
        // path does not sit under the shared root carries that path in full,
        // because for those the tree position genuinely does not locate it.
        // The node name is already the on-disk filename, extension included —
        // `kernel.knowledge.list()` names an entry by its path relative to the
        // knowledge root (`tui/models.md`), not by a stripped slug. Appending an
        // extension here produced `models.md.md`, naming a file that does not
        // exist in a block whose whole job is to be readable straight into
        // `fs.read()`.
        //
        // So the name is used verbatim — EXCEPT where the tree position does
        // not locate the file. That is any entry not under the stated root, and
        // (critically) every entry when there is no shared root to state: a
        // corpus spanning the agent's own store and a module's package has no
        // common prefix, so without the full path here nothing in the block
        // says where those files are.
        const unlocatable = child.file !== undefined && (root === null || !child.file.path.startsWith(root))
        const label = unlocatable ? child.file!.path : name
        const description = child.description ? `  — ${child.description}` : ""
        lines.push(`${prefix}${branch}${label}${description}`)
        if (child.children.size > 0) lines.push(...renderNode(child, childPrefix, depth + 1, root))
    })

    return lines
}

/**
 * The directory every entry's path shares, or null when they do not share one.
 *
 * Knowledge comes from the agent's own store AND from each installed module's
 * package, so several physical roots is the normal case rather than the
 * exception. When they DO share one — the common case for a single-module
 * corpus — stating it once and leaving the leaves relative is worth ~2,900
 * tokens on a 194-file corpus versus repeating a 60-character prefix on every
 * line.
 */
function commonRoot(items: readonly KnowledgeItem[]): string | null {
    const dirs = items.map(item => item.path.slice(0, item.path.lastIndexOf("/") + 1)).filter(Boolean)
    if (dirs.length === 0) return null

    let prefix = dirs[0]!
    for (const dir of dirs) {
        while (prefix && !dir.startsWith(prefix)) {
            // Retreat one directory at a time — a character-wise prefix could
            // cut mid-segment and name a directory that does not exist.
            prefix = prefix.slice(0, prefix.lastIndexOf("/", prefix.length - 2) + 1)
        }
        if (!prefix) return null
    }
    return prefix.length > 1 ? prefix : null
}

/**
 * Render the catalogue as a `tree(1)`-style listing.
 *
 * ── Paths ───────────────────────────────────────────────────────────────────
 *
 * The model reaches these files with `fs.read(path)`, so a path has to be
 * derivable from what it reads here. Repeating the absolute path per entry is
 * how the first pass spent 41% of the block on one string written 194 times;
 * instead the shared root is stated once at the top and each leaf carries only
 * what distinguishes it.
 *
 * A corpus spanning several roots (the agent's own store plus a module's) has
 * no shared prefix to factor out, so those leaves carry their full path. That
 * is strictly rarer and strictly more informative — nothing is hidden either
 * way.
 *
 * Returns a STRING, which AIR passes through untouched (`serializeState`
 * forwards authored output rather than re-serializing it) — so this owns its
 * own formatting end to end and no JSON wrapping is reintroduced underneath it.
 */
export function renderKnowledgeTree(items: readonly KnowledgeItem[]): string {
    const root = commonRoot(items)
    const tree = renderNode(build(items), "", 0, root).join("\n")
    return root ? `${root}\n${tree}` : tree
}
