import type { AxonEntry } from "@arcforge/types"

/**
 * One turn of a preflight exchange.
 *
 * The vocabulary a caller composes a preflight from. Deliberately the SHAPE of
 * a conversation rather than the shape of the renderer's internals: an author
 * writes what happened, and `preflightEntries` below translates it into the
 * session entries the ordinary timeline renderer consumes.
 *
 * It lives here, beside the translation, rather than on `Protocol`. A protocol
 * describes a GRAMMAR — the tags, the rules, what a well-formed reply looks
 * like. A preflight is CONTENT written in that grammar, and which content to
 * show is the caller's decision: a cognet may want a different opening for a
 * different job, and eventually a user may want a different one for a
 * different personality. Baking one exchange into the protocol made that
 * decision unreachable from the only layer that should be making it.
 */
export type PreflightTurn =
    /** Someone speaking to the agent. */
    | { kind: "user"; content: string; channel?: string }
    /** The agent speaking. */
    | { kind: "text"; content: string }
    /** The agent running one block. `id` joins it to its stdout. */
    | { kind: "script"; id: string; code: string }
    /**
     * The result of a script, as the capsule returned it.
     *
     * `error` is what makes a FAILURE demonstrable rather than merely a false
     * `ok`: the renderer stamps `error="policy"` / `error="exception"` on the
     * tag and puts the message above the output, so a preflight showing a
     * denial or a thrown tool call produces exactly the markup a real one
     * does.
     */
    | {
        kind: "stdout"
        for: string
        content: string
        ok?: boolean
        lang?: string
        error?: { kind: "timeout" | "policy" | "interrupt" | "exception"; message: string }
    }
    /** The agent handing control back — the turn boundary. */
    | { kind: "done" }
    /**
     * A run cut short — `from` names the surface that stopped it.
     *
     * Nothing the AGENT says may follow one. On abort the wake commits this
     * and closes its channel (see Wake.execute), so the cognet returns without
     * another inference: the next thing in a real session is always the user
     * speaking again. A preflight that showed the agent replying to its own
     * interruption would be demonstrating a sequence the runtime cannot
     * produce — and demonstrating it at exactly the point where the wrong
     * behaviour (resuming the work it was told to stop) is most tempting.
     */
    | { kind: "interrupt"; reason?: "user" | "shutdown"; from?: string }
    /** Any other runtime signal the agent must read. */
    | { kind: "system"; type: string; content: string; attributes?: Record<string, string> }

/**
 * The opening exchange, as SESSION ENTRIES.
 *
 * Rendered through the ordinary timeline renderer rather than written out as
 * markup, so the demonstration cannot drift from the format it demonstrates.
 * Hand-written strings made the preflight a second implementation of the
 * grammar — the same duplication that let `<meta>` outlive two tag renames and
 * teach models a vocabulary the parser no longer spoke.
 *
 * Every turn shares one `runId`: the whole exchange is one continuous
 * conversation, and the renderer groups an agent's text and script into a
 * single turn by that id. Split ids would render each block as its own turn,
 * demonstrating the exact fragmentation the grouping exists to prevent.
 *
 * Ids are `p*`, never `e*`/`u*` — the real timeline numbers from `e1`, and two
 * blocks answering to one id is the ambiguity `for=` exists to remove.
 */
export function preflightEntries(turns: readonly PreflightTurn[]): AxonEntry[] {
    const entries: AxonEntry[] = []
    let seq = 0

    // One id per agent MESSAGE, not per block. A text and the script beside it
    // are one thing the model said; the renderer needs them to share a wake to
    // fold them together.
    let message = 0
    const wake = (): string => `preflight-${message}`

    const push = (type: string, data: unknown): void => {
        seq++
        entries.push({ id: `pf${seq}`, type, time: { ms: seq, seq }, context: { runId: wake() }, data } as unknown as AxonEntry)
    }

    for (const turn of turns) {
        switch (turn.kind) {
            case "user":
                // A user turn ends the agent's previous message.
                message++
                push("cognet:stimulus:text", { channel: turn.channel ?? "terminal", content: turn.content })
                break
            case "text":
                push("cognet:output:text", { channel: "reply", content: turn.content })
                break
            case "script":
                push("cognet:action:typescript", { id: turn.id, content: turn.code })
                break
            case "stdout":
                // A result is the world answering, so what follows it is a NEW
                // message from the agent rather than a continuation.
                push("cognet:action:result", {
                    for: turn.for,
                    ok: turn.ok ?? true,
                    content: turn.content,
                    ...(turn.error ? { error: turn.error } : {}),
                })
                message++
                break
            case "done":
                push("axon:agent:done", {})
                message++
                break
            case "interrupt":
                push("axon:interrupt", {
                    reason: turn.reason ?? "user",
                    ...(turn.from ? { from: turn.from } : {}),
                })
                message++
                break
            case "system":
                push("axon:system:message", {
                    type: turn.type,
                    lang: "txt",
                    content: turn.content,
                    ...(turn.attributes ? { attributes: turn.attributes } : {}),
                })
                message++
                break
        }
    }

    return entries
}
