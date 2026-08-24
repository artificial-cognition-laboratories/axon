/** Pure scanning helpers for the streaming AIR parser. */

/**
 * Find the first occurrence of `closeTag` in `src` that is not inside a
 * string literal or a comment.
 *
 * Used for code blocks (typescript/script) where the model might write
 * something like `const s = "</script>"` — that must not close the block.
 *
 * COMMENTS ARE PART OF THIS, not a refinement of it. Without them an
 * apostrophe in ordinary prose — `// I'll read the files` — opens a string
 * that never closes, and every subsequent close tag is treated as quoted.
 * The block then runs to the end of the response and reports itself
 * incomplete, silently destroying the whole message. Models write prose
 * comments constantly, so this is not an edge case; it is the common case
 * for any block that explains itself.
 *
 * The scan is deliberately lexical and shallow: strings, template literals
 * (including their ${} holes, which can themselves contain strings and
 * nested backticks), line comments, and block comments. It is not a parser
 * and does not need to be — the only question is whether a given offset is
 * code.
 *
 * Returns -1 if no unquoted, uncommented match is found.
 */
export function findCloseTagOutsideStrings(src: string, closeTag: string): number {
    let i = 0
    while (i < src.length) {
        const ch = src[i]
        const next = src[i + 1]

        // Line comment — runs to the newline. Apostrophes inside are prose.
        if (ch === "/" && next === "/") {
            const nl = src.indexOf("\n", i)
            if (nl === -1) return -1
            i = nl + 1
            continue
        }

        // Block comment — runs to the terminator.
        if (ch === "/" && next === "*") {
            const end = src.indexOf("*/", i + 2)
            if (end === -1) return -1
            i = end + 2
            continue
        }

        // String or template literal.
        if (ch === '"' || ch === "'" || ch === "`") {
            i = skipString(src, i)
            continue
        }

        if (src.startsWith(closeTag, i)) return i

        i++
    }
    return -1
}

/**
 * Skip the string literal starting at `open`, returning the offset just past
 * it (or src.length if it never terminates).
 *
 * Template literals recurse through `${}`: the hole is code, so it may hold
 * strings, comments, and further template literals — and a close tag inside
 * one is genuinely quoted, exactly as it would be anywhere else.
 */
function skipString(src: string, open: number): number {
    const quote = src[open]
    let i = open + 1

    while (i < src.length) {
        const ch = src[i]

        if (ch === "\\") { i += 2; continue }
        if (ch === quote) return i + 1

        // A ${} hole inside a template literal is code, not string content.
        if (quote === "`" && ch === "$" && src[i + 1] === "{") {
            i = skipHole(src, i + 2)
            continue
        }

        i++
    }
    return src.length
}

/** Skip a template-literal `${...}` hole, honouring nesting and quoting inside it. */
function skipHole(src: string, start: number): number {
    let depth = 1
    let i = start

    while (i < src.length && depth > 0) {
        const ch = src[i]

        if (ch === '"' || ch === "'" || ch === "`") {
            i = skipString(src, i)
            continue
        }
        if (ch === "{") depth++
        else if (ch === "}") depth--
        i++
    }
    return i
}
