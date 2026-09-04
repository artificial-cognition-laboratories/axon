import { describe, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AxonSession } from "../src/session"
import { AxonBus } from "@arcforge/core"

/**
 * `opened` vs `restored` — and who is entitled to say either.
 *
 * The TUI renders `axon:session:restored` as "session resumed", so this pair
 * is the difference between a banner that means something and one that shows
 * on every boot. It showed on every boot.
 *
 * TWO rules, and only the first was implemented:
 *
 *  1. A file holding only BUILD events is not a prior conversation — it is
 *     this session's own build, written before the runtime existed. Opening
 *     onto it is an open. (Guarded by `isBuildEvent`.)
 *
 *  2. A NON-PERSISTING session never announces either. It is a projection of
 *     a record someone else owns, so "this conversation began" is not its
 *     statement to make. This is the rule `end()` already applied to
 *     `axon:session:closed` for exactly the same reason — and it was never
 *     applied to the opening pair, so a confined agent opening over the
 *     supervisor's file announced `restored` on its bus, the link forwarded
 *     it, and every fresh boot claimed to be a resume.
 */

function blueprint(root: string, sessionId: string) {
    return {
        agent: { name: "@test/agent", version: "0.0.0" },
        paths: { root, data: "data" },
        session: { id: sessionId },
        env: {},
    } as never
}

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "axon-session-lifecycle-"))
    return { root, cleanup: () => rm(root, { recursive: true, force: true }) }
}

/** Every event type this session announced on its bus, in order. */
function announced(bus: ReturnType<typeof AxonBus>): string[] {
    const seen: string[] = []
    bus.onAny((type: string) => { seen.push(type) })
    return seen
}

describe("session open vs restore", () => {
    it("announces opened on a fresh file", async () => {
        const { root, cleanup } = await fixture()
        const bus = AxonBus()
        const seen = announced(bus)

        const session = await AxonSession({ blueprint: blueprint(root, "s1"), bus })
        await session.end()

        expect(seen).toContain("axon:session:opened")
        expect(seen).not.toContain("axon:session:restored")

        await cleanup()
    })

    it("announces restored when reopening a file with real events", async () => {
        const { root, cleanup } = await fixture()

        const first = await AxonSession({ blueprint: blueprint(root, "s1"), bus: AxonBus() })
        await first.commit("axon:boot:start", {} as never)
        await first.end()

        const bus = AxonBus()
        const seen = announced(bus)
        const second = await AxonSession({ blueprint: blueprint(root, "s1"), bus })
        await second.end()

        expect(seen).toContain("axon:session:restored")
        expect(seen).not.toContain("axon:session:opened")

        await cleanup()
    })

    it("a non-persisting session announces NEITHER", async () => {
        // The regression. The supervisor opens the file and says `opened`;
        // the confined agent then opens the SAME path non-persistently. It
        // must not narrate the session's beginning — the supervisor already
        // did, and by then the file holds real events so this one would say
        // `restored` and the TUI would render "session resumed" on a boot
        // that resumed nothing.
        const { root, cleanup } = await fixture()

        const owner = await AxonSession({ blueprint: blueprint(root, "s1"), bus: AxonBus() })
        await owner.commit("axon:boot:start", {} as never)

        const bus = AxonBus()
        const seen = announced(bus)
        const projection = await AxonSession({
            blueprint: blueprint(root, "s1"),
            bus,
            persist: false,
        })

        expect(seen).not.toContain("axon:session:restored")
        expect(seen).not.toContain("axon:session:opened")

        await projection.end()
        await owner.end()
        await cleanup()
    })
})
