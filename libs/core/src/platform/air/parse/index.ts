import type { GrammarT } from "../grammar"
import type { AirBlockEvent } from "../types"
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
 *   thinking    → inside <thinking>, streaming deltas token-by-token
 *   typescript  → inside <typescript>, buffering silently
 *   shell       → inside <shell>, buffering silently
 *
 * Tags are fixed and non-nesting. No attributes are expected on tags
 * (but tolerated via the regex — e.g. <text lang="en"> still matches).
 */

type BlockTag = "text" | "thinking" | "typescript" | "shell"

/** Blocks whose content streams as deltas. Code blocks buffer silently. */
const STREAMABLE = new Set<BlockTag>(["text", "thinking"])

// Maximum length of any closing tag: "</typescript>" = 13 chars.
// Hold back this many chars in idle mode to avoid splitting a tag across chunks.
const MAX_TAG_LEN = 14

type ParserOpts = {
    grammar: GrammarT
}

export function Parser(opts: ParserOpts) {
    const openTag = new RegExp(`<(${opts.grammar.tags().join("|")})(?:\\s[^>]*)?>`)

    let state: "idle" | BlockTag = "idle"
    let buffer = ""
    let blockContent = ""

    function closeBlock(content: string): AirBlockEvent {
        const tag = state as BlockTag
        switch (tag) {
            case "text": return { type: "text:done", content }
            case "thinking": return { type: "thinking:done", content }
            case "typescript": return { type: "typescript:done", content }
            case "shell": return { type: "shell:done", content }
        }
    }

    /**
     * In idle state, scan for opening tags or <done/>.
     * Returns true if progress was made (something consumed).
     */
    function drainIdle(events: AirBlockEvent[], flushing: boolean): boolean {
        // Repair only the region we could actually act on this pass — the
        // trailing MAX_TAG_LEN chars may still be an in-flight split tag
        // (unless flushing, where the whole buffer is final).
        const safeLen = flushing ? buffer.length : Math.max(0, buffer.length - MAX_TAG_LEN)
        if (safeLen > 0) buffer = repair(buffer.slice(0, safeLen)) + buffer.slice(safeLen)

        const doneMatch = buffer.match(/<done\s*\/>/)
        const openMatch = buffer.match(openTag)

        // Find the earliest match
        let earliest: { type: "done" | "open"; index: number; length: number; tag?: BlockTag } | null = null

        if (doneMatch && doneMatch.index !== undefined) {
            earliest = { type: "done", index: doneMatch.index, length: doneMatch[0].length }
        }
        if (openMatch && openMatch.index !== undefined) {
            if (!earliest || openMatch.index < earliest.index) {
                earliest = { type: "open", index: openMatch.index, length: openMatch[0].length, tag: openMatch[1] as BlockTag }
            }
        }

        if (earliest) {
            // Consume everything up to and including the match
            buffer = buffer.slice(earliest.index + earliest.length)

            if (earliest.type === "done") {
                events.push({ type: "done" })
            } else {
                state = earliest.tag!
                blockContent = ""
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

        const closeIdx = STREAMABLE.has(tag)
            ? buffer.indexOf(closeTag)
            : findCloseTagOutsideStrings(buffer, closeTag)

        if (closeIdx !== -1) {
            // Found closing tag — extract content up to it
            const content = buffer.slice(0, closeIdx)
            buffer = buffer.slice(closeIdx + closeTag.length)

            if (STREAMABLE.has(tag) && content.length > 0) {
                events.push({ type: `${tag}:delta` as "text:delta" | "thinking:delta", content })
            }
            blockContent += content

            events.push(closeBlock(blockContent.trim()))
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
                events.push({ type: `${tag}:delta` as "text:delta" | "thinking:delta", content })
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
