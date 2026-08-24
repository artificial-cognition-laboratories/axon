/**
 * Deterministic, pre-parse repair of raw model output.
 *
 * Scope is deliberately narrow: string-only fixes for mistakes that are
 * common and unambiguous to correct. No semantic guessing, no model calls.
 * If a fix isn't mechanically certain, leave the text alone — the parser's
 * own incomplete/error reporting is the honest fallback, and that goes back
 * to the model as an `agent:output:error` for it to correct itself.
 *
 * Applied to the full buffered response before it reaches the AIR parser.
 */

const KNOWN_TAGS = ["text", "thinking", "typescript", "script", "text"] as const

export function repair(raw: string): string {
    return normalizeTagCase(raw)
}

/**
 * Lowercase tag names the model emitted in the wrong case
 * (`<Text>`, `<TYPESCRIPT>`) — case is not semantically meaningful here,
 * so normalizing it can never change intent, only make it parseable.
 */
function normalizeTagCase(raw: string): string {
    let out = raw
    for (const tag of KNOWN_TAGS) {
        const open = new RegExp(`<(${tag})(\\s[^>]*)?>`, "gi")
        const close = new RegExp(`</(${tag})>`, "gi")
        out = out.replace(open, (match, _name, attrs) => `<${tag}${attrs ?? ""}>`)
        out = out.replace(close, `</${tag}>`)
    }
    return out
}
