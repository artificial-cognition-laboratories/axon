import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fsx } from "../../../utils/fs"

/**
 * Remove the dead `engine:` field from an agent's config, in place.
 *
 * ── Why a migration and not a message ───────────────────────────────────────
 *
 * `engine:` was retired in favour of `providers:` (a source) and `model:` (a
 * preference). For a window it warned and loaded anyway, which turned out to
 * mean agents ran on a DIFFERENT, billed provider than their config named — so
 * it is now fatal at load. That is the right severity and the wrong migration
 * story: every agent already on disk carrying the field stops booting, and the
 * largest population of those is zeno, which most users never created by hand
 * and have no reason to know how to repair.
 *
 * So the field is removed FOR them, mechanically, on the next prepare.
 *
 * ── Why this is safe to do without asking ───────────────────────────────────
 *
 * The field was already being IGNORED. An agent carrying `engine: Codex()` was
 * never running on Codex — it resolved against the profile pool like any agent
 * declaring nothing. Deleting the line therefore changes no behaviour at all;
 * it only makes the file honest about what was already happening. That is what
 * separates this from "updating the user's agent", which this deliberately is
 * not: nothing else in the config is read, moved, or rewritten.
 *
 * ── The one thing that is preserved ─────────────────────────────────────────
 *
 * `engine: Codex({ model: "gpt-5.6-terra" })` named a model. Dropping the line
 * outright would leave the agent with no `model:` at all, and an agent that
 * declares no preference lets the resolver pick from the pool — a different
 * model than the config named. So a model found inside the old call is carried
 * across into `model: "<route>:<model>"`, which is the field that expresses
 * exactly that preference now.
 *
 * That is a behaviour CHANGE in the strict sense — the pin starts being
 * honoured where before it was ignored — and it is the intended one: it makes
 * the agent do what its author wrote, which is what they will expect when they
 * next read the file. An engine call with no model has no preference to carry
 * and simply loses the line.
 */

/** What one config's migration did, for the report. */
export type EngineMigration = {
    /** False when the config never declared `engine:` — the common case. */
    migrated: boolean
    /** The `route:model` preference carried across, when the old call named one. */
    model?: string
}

/**
 * The `engine: X(...)` declaration, as a span in the source.
 *
 * Located textually rather than by parsing: the file is the author's own
 * TypeScript and everything around this one line has to survive byte-identical.
 * The scan walks parentheses and braces so a nested option object
 * (`engine: Codex({ model: "x", effort: "high" })`) is matched to its true end
 * rather than to the first `)` it meets.
 */
type EngineSpan = {
    /** Index of `engine` in the source. */
    start: number
    /** Index just past the declaration, including a trailing comma if present. */
    end: number
    /** The provider factory called — "Axon", "Codex", … */
    factory: string
    /** The `model:` string inside the call, when it named one. */
    model?: string
}

function locateEngine(source: string): EngineSpan | null {
    // `engine` as a KEY: at a line start (after whitespace) and followed by a
    // colon. Anchoring this way keeps the word from matching inside a comment
    // or a string that merely mentions it.
    const match = /^[ \t]*engine[ \t]*:[ \t]*/m.exec(source)
    if (!match) return null

    const start = match.index
    let cursor = match.index + match[0].length

    // The factory name — `Axon`, `Codex`, `Mock`, …
    const name = /^([A-Za-z_$][\w$]*)/.exec(source.slice(cursor))
    if (!name) return null
    const factory = name[1]!
    cursor += name[0].length

    // Walk to the matching close paren, tracking nesting and strings so a
    // brace or paren inside an option value cannot end the scan early.
    while (cursor < source.length && source[cursor] !== "(") cursor++
    if (source[cursor] !== "(") return null

    let depth = 0
    let quote: string | null = null
    let end = -1
    for (let i = cursor; i < source.length; i++) {
        const char = source[i]!
        if (quote) {
            if (char === "\\") i++
            else if (char === quote) quote = null
            continue
        }
        if (char === '"' || char === "'" || char === "`") { quote = char; continue }
        if (char === "(" || char === "{" || char === "[") depth++
        else if (char === ")" || char === "}" || char === "]") {
            depth--
            if (depth === 0) { end = i + 1; break }
        }
    }
    if (end === -1) return null

    const call = source.slice(cursor, end)
    const model = /\bmodel[ \t]*:[ \t]*["']([^"']+)["']/.exec(call)?.[1]

    // Take the trailing comma and the rest of the line with it, so removing a
    // whole declaration does not leave a dangling `,` or a blank line where a
    // field used to be.
    let after = end
    if (source[after] === ",") after++
    while (after < source.length && (source[after] === " " || source[after] === "\t")) after++
    if (source[after] === "\n") after++

    return { start, end: after, factory, ...(model ? { model } : {}) }
}

/**
 * The route name a provider factory maps to in a `model:` string.
 *
 * `model:` is `"<route>:<id>"` and the route is the provider's own name
 * lowercased — the same string `providers:` uses. Only the factories that
 * could carry a model are listed: `Mock` has no catalogue to pin against, so
 * a mock engine loses its line and nothing else.
 */
const ROUTES: Record<string, string> = {
    Axon: "axon",
    Codex: "codex",
    OpenRouter: "openrouter",
    Ollama: "ollama",
    HuggingFace: "huggingface",
}

/**
 * Migrate one agent config, if it declares `engine:`.
 *
 * Idempotent and cheap: a config without the field is read once and left
 * alone, which is every config written after the field was retired.
 */
export async function migrateEngineField(root: string): Promise<EngineMigration> {
    const path = join(root, "axon.config.ts")
    if (!fsx.exists(path)) return { migrated: false }

    const source = await readFile(path, "utf-8").catch(() => "")
    const span = locateEngine(source)
    if (!span) return { migrated: false }

    const route = ROUTES[span.factory]
    const model = span.model && route ? `${route}:${span.model}` : undefined

    // The preference takes the removed declaration's place, so the field lands
    // where its author already had it rather than at the end of the object.
    // Its indentation is the line's own — copied, never assumed.
    const indent = /^[ \t]*/.exec(source.slice(span.start))?.[0] ?? "    "
    const replacement = model ? `${indent}model: "${model}",\n` : ""

    // A config that already declares `model:` keeps it: the author wrote that
    // one deliberately and it is the field the runtime actually reads, so it
    // outranks anything recovered from the dead call.
    const declaresModel = /^[ \t]*model[ \t]*:/m.test(
        source.slice(0, span.start) + source.slice(span.end),
    )

    const next = source.slice(0, span.start)
        + (declaresModel ? "" : replacement)
        + source.slice(span.end)

    await writeFile(path, next, "utf-8")
    return { migrated: true, ...(model && !declaresModel ? { model } : {}) }
}
