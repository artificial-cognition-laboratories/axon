import type { GrammarT } from "../grammar"
import type { AirBlockEvent, AirTextLang } from "../types"
import { repair } from "../repair"
import { findCloseTagOutsideStrings } from "./scan"

/**
 * Streaming AIR parser.
 *
 * Accepts raw token chunks from the model and emits typed block events.
 * Handles tag boundaries that split across chunks via a small lookahead
 * buffer. One parser per engine call — state is per-response.
 *
 * The accepted tag set is derived from the grammar, so the parser and the
 * contract shown to the model can never drift.
 *
 * State machine:
 *   idle        → scanning for an opening tag or <done/>
 *   text        → inside <text>, streaming deltas token-by-token
 *   template    → inside <text>, streaming deltas token-by-token
 *   thinking    → inside <thinking>, streaming deltas token-by-token
 *   typescript  → inside <typescript>, buffering silently
 *   script      → inside <script>, buffering silently
 *
 * Tags are fixed and non-nesting. Attributes are tolerated on any tag, and
 * `lang` is captured on <text> because it selects the interpolation
 * serializer downstream — the only attribute that carries meaning.
 *
 * The parser is synchronous and total: blocks in, block events out, no
 * awaiting and no opinion about what any block MEANS. A template streams
 * because nothing downstream depends on it; a script does not, because half
 * a statement is not runnable. That is the whole rule.
 */

type BlockTag = "thinking" | "script" | "text"

/** Blocks whose content streams as deltas. Code blocks buffer silently. */
const STREAMABLE = new Set<BlockTag>(["thinking", "text"])

/**
 * How much of the buffer to hold back in idle mode so an opening tag split
 * across chunks can still be completed by the next one.
 *
 * This must cover the longest OPENING tag INCLUDING its attributes, not just
 * the longest tag name — hold back fewer and the tag's prefix is flushed as
 * stray text before the rest arrives, so the block never opens and the whole
 * reply parses to nothing.
 *
 * Sized for what the model actually sends, which is what it reads: history
 * renders `<script from="agent" id="e18" lang="typescript">`, models copy
 * those attributes, and 39 characters of them overran an allowance of 16 that
 * had been sized for `lang="json"`. A real run then failed fourteen valid
 * scripts in a row as OUTPUT_EMPTY — every one of them well-formed, every one
 * flushed as text before its opening tag completed.
 *
 * Only reached when a chunk boundary lands inside a tag, which is why it
 * survived every single-delta test and only appeared against a live provider.
 * Generous on purpose: the cost of being too large is a few bytes of latency
 * on the flush, and the cost of being too small is silently discarding a
 * correct reply.
 */
const ATTR_ALLOWANCE = 128

function maxTagLen(tags: string[]): number {
    const longest = tags.reduce((n, t) => Math.max(n, t.length), 0)
    return longest + "</>".length + ATTR_ALLOWANCE
}

/** Templates default to markdown; only an explicit lang="json" changes the serializer. */
function textLang(attrs: string | undefined): AirTextLang {
    return /lang\s*=\s*["']?json["']?/i.test(attrs ?? "") ? "json" : "md"
}

/**
 * The delta event for a streamable tag. An explicit map rather than a
 * template-literal cast: the compiler checks every STREAMABLE tag has one,
 * so adding a streamable block cannot silently produce an unhandled event.
 */
const DELTA = {
    thinking: "thinking:delta",
    text: "text:delta",
} as const satisfies Record<"thinking" | "text", AirBlockEvent["type"]>

function delta(tag: BlockTag, content: string): AirBlockEvent {
    return { type: DELTA[tag as keyof typeof DELTA], content }
}

type ParserOpts = {
    grammar: GrammarT
}

/**
 * Strips the leading indent a model puts on a `<text>` body, as it streams.
 *
 * ── Why the parser and not just the prompt ──────────────────────────────────
 *
 * The renderer used to indent agent speech to sit inside its turn, so models
 * copied it — a transcript is the strongest instruction there is. That is
 * fixed at the source (see `agentBlock` in render/blocks.ts), but four leading
 * spaces IS an indented code block in markdown, so a model doing it anyway
 * turns an entire reply into one unstyled, unwrapped `code_block`. Observed in
 * production: a 9,439-char answer parsed as a single code block instead of 68
 * paragraphs, 14 headings and 24 fences. That is too damaging to leave to
 * prompt discipline, and a model will format its own XML however it likes.
 *
 * ── Why it is stateful ──────────────────────────────────────────────────────
 *
 * Indentation is a property of a LINE START, and a delta is an arbitrary slice
 * of the stream — a chunk routinely begins mid-line. So this tracks whether
 * the next character continues a line or starts one, and only ever strips
 * immediately after a newline.
 *
 * ── Why the width is measured, not assumed ──────────────────────────────────
 *
 * Stripping a fixed four columns would corrupt a body indented by two, and a
 * markdown list ("  - item") is legitimately indented. So the FIRST indented
 * line sets the width, and every later line has at most that much removed —
 * relative indentation inside the block (nested lists, fenced code) survives
 * intact, which is the whole point.
 */
/**
 * The one-shot form of `Dedent`, for content already held whole.
 *
 * Same rule, same result — the streaming and committed paths must agree, or
 * the row on screen and the history the model reads back would differ.
 */
function stripIndent(text: string): string {
    return Dedent().chunk(text)
}

function Dedent() {
    /** Columns to strip per line. Null until the first non-empty line sets it. */
    let width: number | null = null
    /** Whether the next character begins a line. A body opens on one. */
    let atLineStart = true
    /** Leading spaces already skipped on the line being consumed. */
    let skipped = 0
    /** Spaces seen so far on the opening line, while width is still unknown. */
    let measuring = 0

    return {
        /**
         * Feed one delta, get it back with the block's indent removed.
         *
         * A chunk may split a line's leading whitespace, so both the measure
         * and the strip carry across the boundary.
         */
        chunk(text: string): string {
            let out = ""

            for (const char of text) {
                // Still establishing the width from the first non-empty line.
                if (width === null) {
                    if (char === " ") { measuring++; continue }
                    if (char === "\n") { measuring = 0; out += char; continue }
                    // First real character: its column IS the block's indent.
                    // The spaces before it were consumed, which is the strip.
                    width = measuring
                    out += char
                    atLineStart = false
                    continue
                }

                if (atLineStart && char === " " && skipped < width) {
                    skipped++
                    continue
                }

                out += char
                if (char === "\n") { atLineStart = true; skipped = 0 }
                else atLineStart = false
            }

            return out
        },
    }
}

export function Parser(opts: ParserOpts) {
    const tags = opts.grammar.tags()
    const openTag = new RegExp(`<(${tags.join("|")})(\\s[^>]*)?>`)
    const MAX_TAG_LEN = maxTagLen(tags)

    let state: "idle" | BlockTag = "idle"
    let buffer = ""
    let blockContent = ""
    /**
     * Strips the block's own indent from `<text>` as it streams.
     *
     * Markdown only — `<script>` is code, where leading whitespace is content
     * and removing it would corrupt the program. Rebuilt per block, since the
     * width is measured from each body's first line.
     */
    let dedent = Dedent()

    function closeBlock(content: string): AirBlockEvent {
        const tag = state as BlockTag
        switch (tag) {
            case "thinking": return { type: "thinking:done", content }
            case "script": return { type: "script:done", content }
            case "text": return { type: "text:done", content }
        }
    }

    /**
     * In idle state, scan for an opening tag or <done/>.
     * Returns true if progress was made (something consumed).
     */
    function drainIdle(events: AirBlockEvent[], flushing: boolean): boolean {
        // Repair only the region we could actually act on this pass — the
        // trailing MAX_TAG_LEN chars may still be an in-flight split tag
        // (unless flushing, where the whole buffer is final).
        const safeLen = flushing ? buffer.length : Math.max(0, buffer.length - MAX_TAG_LEN)
        if (safeLen > 0) buffer = repair(buffer.slice(0, safeLen)) + buffer.slice(safeLen)

        // Attributes tolerated, exactly as openTag tolerates them. The model
        // is taught bare `<done/>`, but every OTHER tag it writes takes
        // attributes (`<text from="agent" lang="md">`), so it drifts into
        // `<done from="agent"/>` on its own. Under the bare-only pattern that
        // stop signal was silently dropped: the turn did not end, the loop
        // woke the agent again, and it answered a second time — a duplicated
        // reply and a second billed generation, with nothing in the trace
        // saying why. `done` carries no attributes today; they are discarded
        // rather than parsed, because accepting the signal is the point.
        const doneMatch = buffer.match(/<done(\s[^>]*)?\/>/)
        const openMatch = buffer.match(openTag)

        // Whichever comes first — a <done/> after a block belongs to that
        // block's turn, one before it does not end a block that follows.
        let earliest: { kind: "done" | "open"; index: number; length: number } | null = null
        if (doneMatch?.index !== undefined) {
            earliest = { kind: "done", index: doneMatch.index, length: doneMatch[0].length }
        }
        if (openMatch?.index !== undefined && (!earliest || openMatch.index < earliest.index)) {
            earliest = { kind: "open", index: openMatch.index, length: openMatch[0].length }
        }

        if (earliest) {
            buffer = buffer.slice(earliest.index + earliest.length)

            if (earliest.kind === "done") {
                events.push({ type: "done" })
                return true
            }

            state = openMatch![1] as BlockTag
            // Fresh width per block. Each body measures its own first line, so
            // carrying one over would strip the wrong amount: a shallow block
            // followed by a deeply indented one left the deltas still indented
            // while `text:done` was clean — the row on screen and the history
            // the model reads back disagreeing about the same message.
            dedent = Dedent()
            blockContent = ""
            // Announced at open, not at close: the consumer must know which
            // serializer applies before the first delta arrives, since
            // deltas are released as they stream.
            if (state === "text") {
                events.push({ type: "text:open", lang: textLang(openMatch![2]) })
            }
            return true
        }

        // No match found. If not flushing, hold back MAX_TAG_LEN chars
        // in case a tag is split across chunks.
        if (!flushing && buffer.length > MAX_TAG_LEN) {
            // Discard content before the holdback — it's bare text outside tags
            buffer = buffer.slice(buffer.length - MAX_TAG_LEN)
            return true // made progress by discarding
        }

        if (flushing) {
            buffer = ""
            return false
        }

        return false
    }

    /**
     * Inside a block, scan for the matching closing tag.
     * For streamable blocks (text, thinking), emit deltas as content arrives.
     * For code blocks (typescript, shell), string-aware scanning avoids
     * closing early on tags that appear inside string literals.
     *
     * The holdback (withholding the last `closeTag.length` chars, in case a
     * chunk boundary splits the tag) only makes sense mid-stream. On flush,
     * the stream is over — there is no next chunk to complete a split tag —
     * so the entire remaining buffer is genuine final content and must be
     * consumed in full, or the tail silently vanishes from the incomplete
     * block's reported content.
     */
    function drainBlock(events: AirBlockEvent[], flushing: boolean): boolean {
        const tag = state as BlockTag
        const closeTag = `</${tag}>`
        const streamable = STREAMABLE.has(tag)

        /**
         * Code blocks scan from the START of the block, not from the
         * unconsumed tail. String-literal state is only meaningful over the
         * whole block: scanning a mid-code fragment starts outside a string
         * by assumption, so a chunk boundary falling inside one (`fs.list("`
         * / `src")`) would leave the scanner permanently mis-synced and it
         * would never find the real closing tag. Streamable blocks have no
         * such state, so they scan the tail directly.
         */
        const scanned = streamable ? buffer : blockContent + buffer
        const offset = streamable ? 0 : blockContent.length

        const found = streamable
            ? scanned.indexOf(closeTag)
            : findCloseTagOutsideStrings(scanned, closeTag)
        const closeIdx = found === -1 ? -1 : found - offset

        if (closeIdx !== -1) {
            // Found closing tag — extract content up to it
            const content = buffer.slice(0, closeIdx)
            buffer = buffer.slice(closeIdx + closeTag.length)

            if (STREAMABLE.has(tag) && content.length > 0) {
                events.push(delta(tag, tag === "text" ? dedent.chunk(content) : content))
            }
            blockContent += content

            // The committed content must match what streamed, or the timeline
            // row and the history the model reads back disagree.
            events.push(closeBlock(tag === "text" ? stripIndent(blockContent).trim() : blockContent.trim()))
            state = "idle"
            blockContent = ""
            return true
        }

        // No closing tag yet. For streamable blocks, emit what we have but
        // hold back enough chars to detect a split closing tag — unless
        // flushing, where there's nothing left to arrive.
        const holdback = flushing ? 0 : closeTag.length
        const available = buffer.length - holdback

        if (available > 0) {
            const content = buffer.slice(0, available)
            buffer = buffer.slice(available)
            blockContent += content

            if (STREAMABLE.has(tag)) {
                events.push(delta(tag, tag === "text" ? dedent.chunk(content) : content))
            }
            return true
        }

        return false
    }

    function drain(flushing = false): AirBlockEvent[] {
        const events: AirBlockEvent[] = []

        while (buffer.length > 0) {
            const consumed = state === "idle" ? drainIdle(events, flushing) : drainBlock(events, flushing)
            if (!consumed) break
        }

        return events
    }

    return {
        /** Feed a chunk of raw tokens. Returns any events that can be emitted. */
        feed(chunk: string): AirBlockEvent[] {
            buffer += chunk
            return drain()
        },

        /**
         * Signal end of stream. Flushes any remaining buffered content.
         * If inside an unclosed block, emits a done event with `incomplete: true` —
         * callers must treat these as format errors, never as valid actions.
         */
        flush(): AirBlockEvent[] {
            const events = drain(true)

            // Stream ended mid-block — emit what we have, flagged as incomplete.
            if (state !== "idle") {
                const event = closeBlock(blockContent) as AirBlockEvent & { incomplete?: true }
                event.incomplete = true
                events.push(event)
            }

            state = "idle"
            buffer = ""
            blockContent = ""
            return events
        },
    }
}

export type ParserT = ReturnType<typeof Parser>
