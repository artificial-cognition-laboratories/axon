/** Pure string utilities for AIR rendering. */

/** Escape XML text content (prose, stdout, user messages). */
export function esc(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/** Escape a trusted value for a double-quoted XML attribute. */
export function escAttr(s: string): string {
    return esc(s).replace(/"/g, "&quot;").replace(/'/g, "&apos;")
}

/** Escape XML inside code blocks — only & and <. Never > (breaks =>, generics). */
export function escCode(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;")
}

/** Indent every line of s by `spaces` spaces. */
export function indent(s: string, spaces: number): string {
    const pad = " ".repeat(spaces)
    return s
        .split("\n")
        .map(line => pad + line)
        .join("\n")
}

/**
 * A fence long enough to hold `body` without being closed early by it.
 *
 * A block declaring `lang="md"` must contain VALID markdown, and a three-tick
 * fence around text that itself contains three ticks terminates at the wrong
 * place — the remainder spills out as prose and the model reads a broken
 * document. Model output is exactly where that happens: a rejected reply
 * routinely contains fenced examples of its own.
 *
 * CommonMark's rule is that a fence is closed only by a run of at least its
 * own length, so one longer than the longest run inside is always safe.
 */
export function fenceFor(body: string): string {
    const longest = [...body.matchAll(/`+/g)].reduce((max, m) => Math.max(max, m[0].length), 0)
    return "`".repeat(Math.max(3, longest + 1))
}

export function formatBytes(n: number): string {
    return n >= 1024 ? `${(n / 1024).toFixed(1)}K` : `${n}B`
}

/**
 * Normalize code that may contain literal \n or \t escape sequences outside
 * of string literals (a common model mistake). Replaces them with real
 * whitespace so the timeline shows clean, executable code.
 *
 * Best-effort heuristic: only acts on \n/\t outside single-quoted,
 * double-quoted, or template-literal strings.
 */
export function normalizeCode(code: string): string {
    // Fast path: no escape sequences at all
    if (!code.includes("\\n") && !code.includes("\\t")) return code

    let result = ""
    let i = 0
    while (i < code.length) {
        const c = code[i]
        // Track string boundaries to avoid replacing inside strings
        if (c === '"' || c === "'" || c === "`") {
            const quote = c
            result += c
            i++
            while (i < code.length) {
                const sc = code[i]
                if (sc === "\\") {
                    // Keep escape sequences inside strings as-is
                    result += code[i] + (code[i + 1] ?? "")
                    i += 2
                } else if (sc === quote) {
                    result += sc
                    i++
                    break
                } else {
                    result += sc
                    i++
                }
            }
        } else if (c === "\\" && i + 1 < code.length) {
            const next = code[i + 1]
            if (next === "n") {
                result += "\n"
                i += 2
            } else if (next === "t") {
                result += "\t"
                i += 2
            } else {
                result += c + next
                i += 2
            }
        } else {
            result += c
            i++
        }
    }
    return result
}
