/** Pure scanning helpers for the streaming AIR parser. */

/**
 * Find the first occurrence of `closeTag` in `src` that is not inside a
 * string literal (single-quote, double-quote, or template-literal).
 *
 * Used for code blocks (typescript/shell) where the model might write
 * something like `const s = "</typescript>"` — that must not close the block.
 *
 * Returns -1 if no unquoted match is found.
 */
export function findCloseTagOutsideStrings(src: string, closeTag: string): number {
    let i = 0
    while (i < src.length) {
        const ch = src[i]

        // Enter a string literal — skip until the matching unescaped quote.
        if (ch === '"' || ch === "'" || ch === "`") {
            const quote = ch
            i++
            while (i < src.length) {
                if (src[i] === "\\") { i += 2; continue }
                if (src[i] === quote) { i++; break }
                i++
            }
            continue
        }

        // Check for closing tag at this position.
        if (src.startsWith(closeTag, i)) return i

        i++
    }
    return -1
}
