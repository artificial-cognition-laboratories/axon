import { describe, expect, test } from "bun:test"
import grammar from "../../src/air.tmLanguage.json"

/**
 * The grammar and the renderer must agree on the tag vocabulary.
 *
 * This exists because they DID drift, silently and for a long time: the
 * renderer unified `<typescript>`/`<shell>` into `<script lang="...">`, and the
 * grammar — living in another package entirely — kept matching the old tags.
 * Nothing failed. Every `<script>` block fell through to the unknown-tag rule
 * and its TypeScript body rendered as flat grey text, which reads as "the
 * highlighter is a bit weak" rather than as a bug.
 *
 * A syntax grammar has no type system and no consumer that throws, so a rename
 * on either side is invisible until a human notices the colours are wrong. This
 * is the only thing that catches it.
 */

/** Every tag literal named anywhere in the grammar's patterns. */
function grammarTags(): Set<string> {
    const tags = new Set<string>()
    // The tag alternations live in `begin`/`match` as `(script|scope)` groups.
    // Reading them out of the JSON rather than maintaining a second list is the
    // whole point — a list would be the third place that can drift.
    const walk = (node: unknown): void => {
        if (Array.isArray(node)) return node.forEach(walk)
        if (!node || typeof node !== "object") return
        for (const [key, value] of Object.entries(node)) {
            if ((key === "begin" || key === "match") && typeof value === "string") {
                // `(<)(script|scope)` and `(<)(done)` — the group directly
                // after the opening-bracket capture.
                const match = /\(<\\?\/?\??\)\(([a-z|-]+)\)/.exec(value)
                if (match) for (const tag of match[1]!.split("|")) tags.add(tag)
            }
            walk(value)
        }
    }
    walk(grammar.repository)
    return tags
}

describe("the grammar covers what the renderer emits", () => {
    /**
     * Hand-written, and deliberately so: it is the ASSERTION, not a derivation.
     * Deriving it from the renderer would make both sides move together and
     * test nothing. A tag added to the renderer fails here until someone
     * decides how it should be coloured.
     */
    const EMITTED = ["script", "scope", "text", "system", "stdout", "state", "agent", "timeline", "done"]

    test("every tag the renderer emits has a pattern", () => {
        const covered = grammarTags()
        const missing = EMITTED.filter(tag => !covered.has(tag))

        expect(missing).toEqual([])
    })

    test("names itself text.air, which is what consumers register", () => {
        // Fleet's highlighter and the TUI's vterm.config both load this by
        // scopeName; renaming it silently unhighlights AIR in both.
        expect(grammar.scopeName).toBe("text.air")
    })

    test("embeds only grammars its consumers actually load", () => {
        // A body pointing at a grammar the highlighter has not loaded degrades
        // to plain text with no error — the exact silent failure this file is
        // about. Fleet loads ts/json/markdown/xml/vue.
        const embedded = JSON.stringify(grammar).match(/"(source|text)\.[a-z.]+"/g) ?? []
        const allowed = new Set(['"source.ts"', '"source.json"', '"text.html.markdown"'])

        for (const scope of embedded) {
            if (scope === '"text.air"') continue
            expect(allowed.has(scope)).toBe(true)
        }
    })
})
