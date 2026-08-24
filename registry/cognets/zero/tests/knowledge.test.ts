import { describe, expect, test } from "bun:test"
import { renderKnowledgeTree, type KnowledgeItem } from "../src/knowledge"

/**
 * The knowledge tree the model reads every turn.
 *
 * ── What actually needs defending ───────────────────────────────────────────
 *
 * Two things, and the second is the one that bites.
 *
 * SIZE, because this block is resident: it renders into every call, so its cost
 * is paid once per turn for the life of the session. The list it replaced spent
 * four fifths of ~9,400 tokens on JSON scaffolding and on the shared prefix of
 * every name, rewritten in full on every line.
 *
 * TRUTH, because the model builds a read path straight out of this tree. A leaf
 * that names a file which does not exist is worse than an absent one — it sends
 * the model to open something, the read fails, and the failure looks like a
 * missing document rather than a lying index. Two shapes got that wrong during
 * development and both are pinned below: a folded index rendered as `docs.md`
 * when the real file is `docs/index.md`, and a directory whose only entry is
 * its own index, which has no children to reveal that it is a directory at all.
 */

/**
 * One entry, shaped as `kernel.knowledge.list()` really returns it.
 *
 * `name` is the on-disk path relative to the knowledge root, EXTENSION
 * INCLUDED (`tui/models.md`) — not a stripped slug. That detail is load-bearing
 * and is why these fixtures spell it out: an earlier version of this file
 * stripped `.md`, the renderer was built against that shape, and it shipped
 * appending an extension the name already had. Every leaf rendered as
 * `models.md.md`, naming files that do not exist.
 */
function item(name: string, path: string, description = ""): KnowledgeItem {
    return { name, description, path }
}

const ROOT = "/agent/data/knowledge/"

describe("knowledge tree", () => {
    test("renders the shared root once, not per entry", () => {
        // The whole point. The old format repeated a 60-character absolute path
        // on all 194 lines of the reference corpus.
        const tree = renderKnowledgeTree([
            item("docs/a.md", `${ROOT}a.md`),
            item("docs/b.md", `${ROOT}b.md`),
        ])

        expect(tree.split("\n")[0]).toBe(ROOT)
        expect(tree.split(ROOT).length - 1).toBe(1)
    })

    test("names each path segment once in the tree body", () => {
        // The saving. A flat list writes `docs/deep/nested/` on both lines;
        // the tree writes each segment once and lets indentation carry it.
        // Counted below the root line, which legitimately restates the prefix.
        const body = renderKnowledgeTree([
            item("docs/deep/nested/one.md", `${ROOT}deep/nested/one.md`),
            item("docs/deep/nested/two.md", `${ROOT}deep/nested/two.md`),
        ]).split("\n").slice(1).join("\n")

        expect(body.split("nested").length - 1).toBe(1)
    })

    describe("every leaf names a file that exists", () => {
        test("a file leaf carries its extension exactly once", () => {
            // `.md.md` shipped: the name already ends in the extension, and the
            // renderer appended another. The block's only job is to be readable
            // straight into fs.read(), so a doubled extension makes every leaf
            // a dead link.
            const tree = renderKnowledgeTree([item("docs/guide.md", `${ROOT}guide.md`)])
            expect(tree).toContain("guide.md")
            expect(tree).not.toContain("guide.md.md")
        })

        test("a folded index does NOT become <dir>.md", () => {
            // `docs/index.md` describes the docs SECTION. Rendering it as
            // `docs.md` names a file that does not exist.
            const tree = renderKnowledgeTree([
                item("docs/index.md", `${ROOT}index.md`, "Everything"),
                item("docs/guide.md", `${ROOT}guide.md`),
            ])

            expect(tree).not.toContain("docs.md")
            expect(tree).toContain("docs  — Everything")
        })

        test("a directory whose ONLY entry is its index is still a directory", () => {
            // The case that shipped broken: `tools/index.md` folds onto `tools`,
            // which then has no children — so "has children" could not tell it
            // apart from a file, and it rendered as `tools.md`.
            // A sibling elsewhere keeps the shared root above `tools/`, so the
            // directory actually renders as a node rather than being absorbed
            // into the root line.
            const tree = renderKnowledgeTree([
                item("docs/tools/index.md", `${ROOT}tools/index.md`, "What an agent can call"),
                item("docs/other.md", `${ROOT}other.md`),
            ])

            // Rendered as a directory, not as `tools.md` — a file that does
            // not exist. Its overview stays reachable at `tools/index.md`.
            expect(tree).not.toContain("tools.md")
            expect(tree).toContain("tools  — What an agent can call")
        })

        test("an entry outside the shared root carries its full path", () => {
            // Knowledge spans the agent's own store and each module's package,
            // so entries with no shared prefix are normal. For those the tree
            // position does not locate the file, and the full path is the only
            // honest answer.
            const tree = renderKnowledgeTree([
                item("docs/a.md", `${ROOT}a.md`),
                item("docs/b.md", `${ROOT}b.md`),
                item("mod/x.md", "/elsewhere/mod/x.md"),
            ])

            expect(tree).toContain("/elsewhere/mod/x.md")
        })
    })

    describe("descriptions", () => {
        test("a description that restates the name is dropped", () => {
            // 68 of 194 entries in the reference corpus: `axon.md` → "axon".
            const tree = renderKnowledgeTree([item("docs/models.md", `${ROOT}models.md`, "Models")])
            expect(tree).not.toContain("—")
        })

        test("the extension does not make a restated name look informative", () => {
            // A name arrives as `models.md` and its frontmatter title as
            // "Models". Comparing without stripping the extension made every
            // such pair look distinct and kept 68 lines that say nothing.
            const tree = renderKnowledgeTree([item("docs/models.md", `${ROOT}models.md`, "Models")])
            expect(tree).not.toContain("—")
        })

        test("a description naming a DIFFERENT thing is kept", () => {
            // `package.md` documenting "package.json" is not a restatement —
            // it names the artifact the page is about. The rule drops echoes,
            // not anything that merely shares a word.
            const tree = renderKnowledgeTree([item("docs/package.md", `${ROOT}package.md`, "package.json")])
            expect(tree).toContain("— package.json")
        })

        test("a description that adds meaning is kept", () => {
            const tree = renderKnowledgeTree([
                item("docs/config.md", `${ROOT}config.md`, "How an agent declares its engine and modules"),
            ])
            expect(tree).toContain("— How an agent declares its engine and modules")
        })
    })

    test("collapses below the depth cap, still reporting what is there", () => {
        // Insurance for a module shipping a deep corpus. A collapsed directory
        // must still say material exists there — silence would read as empty.
        const deep = [
            item("a/b/c/d/e/one.md", `${ROOT}b/c/d/e/one.md`),
            item("a/b/c/d/e/two.md", `${ROOT}b/c/d/e/two.md`),
        ]
        const tree = renderKnowledgeTree(deep)

        expect(tree).toContain("(2 files)")
        expect(tree).not.toContain("one.md")
    })

    test("an empty catalogue renders nothing rather than a bare root", () => {
        expect(renderKnowledgeTree([])).toBe("")
    })
})
