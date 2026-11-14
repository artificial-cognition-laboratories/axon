import { manifest } from "@arcforge/body"
import type { body } from "@arcforge/types"
import type { AxonSessionT } from "@arcforge/session"

/**
 * The body this agent wears, as the kernel knows it: whatever connects the
 * agent to a body (the body module) tells it here, and a cognet reads it as
 * `kernel.body()`.
 *
 * A manifest is checked as it arrives — the boundary where a body's word
 * becomes the mind's — and recorded in the session before anything reads it,
 * so every reading after it in the log means something in its terms.
 */
export function Body(opts: { session: AxonSessionT }) {
    let worn: body.Manifest | null = null
    let presence: Present | null = null

    return {
        current(): body.Manifest | null {
            return worn
        },
        presence(): Present | null {
            return presence
        },
        /** Whether the worn body is the mind's to move now; a body that is detached has left, by `leave`. */
        async present(said: Present): Promise<void> {
            if (worn === null) throw new Error(`the body said it is ${said.state}, but none is worn`)
            await opts.session.commit("axon:body:presence", said.state === "embodied" ? { state: said.state } : { state: said.state, why: said.why })
            presence = said
        },
        async wear(described: unknown): Promise<body.Manifest> {
            const checked = manifest.check(described)
            await opts.session.commit("axon:body:worn", { manifest: checked })
            worn = checked
            return checked
        },
        async leave(why: string): Promise<void> {
            if (worn === null) return
            worn = null
            presence = null
            await opts.session.commit("axon:body:left", { why: why })
        },
    }
}

/** A body's presence while worn: anything but detached, which is leaving. */
type Present = Exclude<body.Presence, { state: "detached" }>

export type BodyT = ReturnType<typeof Body>
