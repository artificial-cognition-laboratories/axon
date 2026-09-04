import { describe, it, expect } from "bun:test"
import { Blueprint, mergeCapsuleConfig } from "../src/blueprint"

/**
 * A hot reload must be able to REMOVE an environment variable.
 *
 * `.env` is read on every blueprint scan, so a reload carries the file's
 * current contents. But the merge was `{ ...current.env, ...partial.env }`,
 * and a spread cannot express a deleted key: the old value stayed live in the
 * capsule for the rest of the session while the file said otherwise.
 *
 * That is the operation that matters most here. Deleting a line from `.env` is
 * how a user revokes a credential — a leaked token, a key they are rotating —
 * and "the file no longer has it, the running agent still does" is the same
 * reads-as-enforced-but-is-not shape that made `policy` replace rather than
 * merge (see the note beside it).
 */
describe("capsule blueprint: env on reload", () => {
    const base = () => Blueprint({ env: { TOKEN: "old", KEEP: "yes" } })

    it("applies a changed value", () => {
        const next = mergeCapsuleConfig(base(), { env: { TOKEN: "new", KEEP: "yes" } })

        expect(next.env.TOKEN).toBe("new")
    })

    it("REMOVES a key the new env no longer declares", () => {
        // The bug: a revoked credential outliving its removal.
        const next = mergeCapsuleConfig(base(), { env: { KEEP: "yes" } })

        expect(next.env.TOKEN).toBeUndefined()
        expect(next.env.KEEP).toBe("yes")
    })

    it("clears everything when the file is emptied", () => {
        // Present-and-empty is a statement, not an absence.
        const next = mergeCapsuleConfig(base(), { env: {} })

        expect(Object.keys(next.env)).toHaveLength(0)
    })

    it("leaves env alone when the update says nothing about it", () => {
        // A partial that omits `env` is making no claim, so the current value
        // stands — this is what keeps a policy-only update from wiping the
        // environment.
        const next = mergeCapsuleConfig(base(), {})

        expect(next.env).toEqual({ TOKEN: "old", KEEP: "yes" })
    })
})
