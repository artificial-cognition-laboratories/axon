import type { AxonEntry } from "@arcforge/types"
import type { PreflightTurn } from "../protocol/protocol"

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
                push("cognet:action:result", { for: turn.for, ok: turn.ok ?? true, content: turn.content })
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
