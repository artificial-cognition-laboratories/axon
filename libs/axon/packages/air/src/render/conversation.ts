import type { AxonEntry } from "@arcforge/types"
import type { AirMessage } from "../types"
import type { GrammarT } from "../grammar"
import { type RenderedItem, timelineItems } from "./blocks"
import { formatCapsuleOutput } from "./output"
import { esc, escAttr, escCode, fenceFor, indent, normalizeCode } from "./text"

/**
 * The history as a CONVERSATION — real user and assistant messages.
 *
 * The alternative (`renderTimeline`) renders the same turns as one `<timeline>`
 * document delivered in a single `user` message. That shape is what a captured
 * failing context showed:
 *
 * ```
 * role: "user"
 * <timeline>
 *     <user id="u1" channel="terminal" lang="md">…what the user actually said…</user>
 * </timeline>
 * ```
 *
 * Two things follow, and both were observed. The user's words arrive nested
 * two levels inside markup, so being addressed at all is something the model
 * must infer rather than read. And the model's own past replies live in that
 * same `user` message — so **it never sees an `assistant` turn in its own
 * context**. Nothing demonstrates what its output is supposed to look like,
 * and a model with no in-context example of a filled `<text>` emits an
 * empty one: it produces the shape it was instructed to produce while the
 * content evaporates.
 *
 * Here each turn becomes the role it actually was. The tag vocabulary is
 * untouched — an assistant message still carries `<text>`/`<script>`
 * blocks, exactly as the contract describes — so this is independent of any
 * decision about the tag names themselves.
 *
 * Results come back as `user` messages rather than a third role: `tool` is
 * only meaningful paired with a provider-native tool call, and inventing one
 * without it is the same category error as the document format. A capsule
 * result is the world answering, which is what a user turn is.
 */
export function renderConversation(
    entries: readonly AxonEntry[],
    grammar: GrammarT,
    opts?: {
        /**
         * Prefix for the short ids this render assigns — `e`/`u` by default.
         *
         * The preflight passes `p`, so its blocks cannot collide with the real
         * timeline's. Two blocks answering to one id is exactly the ambiguity
         * `for=` exists to remove, and a demonstration that shadows the live
         * conversation's ids would create it on every call.
         */
        idPrefix?: string
    },
): AirMessage[] {
    const prefix = opts?.idPrefix ?? ""
    const items = timelineItems(entries)
    if (items.length === 0) return []

    const messages: AirMessage[] = []
    let userCount = 0
    let execCount = 0
    const execIdMap = new Map<string, string>()
    const shortExecId = (rawId: string): string => {
        if (!execIdMap.has(rawId)) execIdMap.set(rawId, `${prefix}e${++execCount}`)
        return execIdMap.get(rawId)!
    }

    /**
     * One turn, one message. Nothing is merged.
     *
     * An earlier version joined consecutive same-role messages, on the theory
     * that a stdout followed by a correction is one uninterrupted "here is
     * what happened" and some providers dislike back-to-back user turns. It
     * silently destroyed input: after a hot-reload the `<system>` notice and
     * the user's actual words merged into one message, and every consumer that
     * inspects the head of a turn to decide what it is — the mock's
     * `extractUserText`, and any model reading it — saw a system notice and
     * skipped the words entirely. The user's message vanished from the
     * request.
     *
     * A turn is a unit of the record. Fusing two of them is a lie about what
     * happened, and provider tolerance for adjacent same-role messages is not
     * worth being wrong about what was said.
     */
    const push = (role: AirMessage["role"], content: string): void => {
        if (content) messages.push({ role, content })
    }

    for (let i = 0; i < items.length; i++) {
        const item = items[i]!

        if (item.role === "user") {
            // ONE TYPE AXIS: the tag says what a block IS, `from` says who
            // produced it. `<user>` and `<agent>` were on a different axis
            // from `<text>`/`<script>`, which is why `<agent>` had to NEST —
            // and nesting showed the model a fourth tag its own contract said
            // did not exist. It imitated its history, correctly, and was
            // rejected for it.
            //
            // The channel is the return address and has to survive: without it
            // the mind cannot answer on the line the message arrived on.
            const channel = escAttr(item.channel ?? "terminal")
            push("user", `<text from="user" id="${prefix}u${++userCount}" channel="${channel}" lang="${escAttr(item.lang)}">\n${indent(esc(item.content.trim()), 4)}\n</text>`)
            continue
        }

        if (item.type === "result") {
            const ok = item.ok ? ` ok="true"` : ` ok="false"`
            const kindAttr = item.error ? ` error="${escAttr(item.error.kind)}"` : ""
            const body = item.error
                ? [esc(`${item.error.kind}: ${item.error.message}`), esc(formatCapsuleOutput(item.content.trim()))]
                    .filter(part => part.length > 0).join("\n\n")
                : esc(formatCapsuleOutput(item.content.trim()))
            push("user", `<stdout for="${shortExecId(item.for)}" lang="${escAttr(item.lang)}"${ok}${kindAttr}>\n${indent(body, 4)}\n</stdout>`)
            continue
        }

        // A run cut short — its own top-level marker, like `<done/>`.
        //
        // On the USER side, because an interrupt is something that HAPPENED to
        // the agent rather than something it chose: rendering it as an
        // assistant turn would read as the agent announcing its own stop.
        if (item.type === "interrupt") {
            const from = item.from ? ` from="${escAttr(item.from)}"` : ""
            push("user", `<interrupt${from} reason="${escAttr(item.reason)}"/>`)
            continue
        }

        if (item.type === "system") {
            // System facts stay in the user channel: they are the runtime
            // speaking to the model mid-conversation, and an assistant message
            // would attribute them to the model itself.
            const extra = Object.entries(item.attributes ?? {})
                .filter(([key]) => key !== "type" && key !== "lang")
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([key, value]) => ` ${key}="${escAttr(value)}"`)
                .join("")
            push("user", `<system type="${escAttr(item.systemType)}" lang="${escAttr(item.lang)}"${extra}>\n${indent(item.content.trim(), 4)}\n</system>`)
            continue
        }

        // A rejected reply is the model's own output, so it is an assistant
        // turn — the model must see it as something IT said, not as a report
        // about something it said.
        if (item.type === "malformed") {
            // The rejected reply, shown AS THE BLOCKS IT WAS.
            //
            // Two earlier versions wrapped it — first in `<system>`, then in a
            // fenced `<text>` — and both lied about what the model sent: a
            // reply that was a `<script>` rendered as text containing a fenced
            // string. `status="rejected"` on the block itself is the whole
            // fact, in the model's own vocabulary, needing no prose to explain
            // the wrapper.
            //
            // Raw and unparsed: the point is that it sees exactly the bytes it
            // produced, and a reply that failed to parse cannot be re-derived
            // into blocks without guessing at what it meant.
            push("assistant", stampRejected(item.content.trim()))
            continue
        }

        // One model message is one wake: a reply carrying both a text block
        // and a script committed several entries sharing a runId, and they
        // belong in ONE assistant message. Split apart they read as two turns,
        // which is the fidelity failure the document renderer's grouping also
        // exists to prevent.
        //
        // They sit side by side at the top level rather than inside `<agent>`.
        // The assistant ROLE already says the model spoke, so the wrapper was
        // redundant — and worse, it was a fourth tag the contract never named,
        // which the model duly imitated and was rejected for.
        const blocks: string[] = []
        const block = (entry: RenderedItem): string => {
            // The turn boundary, inside the turn it ends — never its own
            // message. A `<done/>` alone in an assistant turn would read as a
            // reply whose entire content was "I am finished".
            if (entry.type === "done") return `<done from="agent"/>`
            if (entry.type === "message") {
                return `<text from="agent" lang="${escAttr(entry.lang)}">\n${indent(esc(entry.content.trim()), 4)}\n</text>`
            }
            if (entry.type === "execute") {
                return `<script from="agent" id="${shortExecId(entry.id)}" lang="${escAttr(entry.lang)}">\n${indent(escCode(normalizeCode(entry.code.trim())), 4)}\n</script>`
            }
            return ""
        }

        blocks.push(block(item))
        while (
            item.runId !== undefined
            && items[i + 1]?.role === "agent"
            && items[i + 1]?.type !== "result"
            && items[i + 1]?.type !== "malformed"
            && items[i + 1]?.runId === item.runId
        ) {
            blocks.push(block(items[++i]!))
        }

        push("assistant", blocks.filter(Boolean).join("\n"))
    }

    return messages
}

/**
 * The model's rejected output, with `status="rejected"` on each block it sent.
 *
 * Operates on the RAW text rather than on parsed blocks, because a reply is
 * rejected precisely when it did not parse cleanly — re-deriving structure
 * from it would mean guessing. So this stamps the attribute onto whatever
 * opening tags are there and leaves everything else, including anything
 * malformed, exactly as the model wrote it.
 *
 * Text outside any block is kept too: on an OUTPUT_EMPTY that stray prose IS
 * the reply, and dropping it would show the model an empty rejection.
 */
function stampRejected(raw: string): string {
    const stamped = raw.replace(
        /<(text|script)(\s[^>]*?)?>/g,
        (_match, tag: string, attrs: string | undefined) => `<${tag}${attrs ?? ""} status="rejected">`,
    )
    // Nothing to stamp means the reply had no recognisable block at all. It
    // still has to be visible — that is the OUTPUT_EMPTY case — so it is
    // framed as the text it effectively was.
    if (stamped === raw) {
        return `<text from="agent" status="rejected" lang="md">\n${indent(esc(raw), 4)}\n</text>`
    }
    return stamped
}
