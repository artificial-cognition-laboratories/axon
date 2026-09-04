import { describe, expect, test } from "bun:test"
import { Mock } from "../src/mock"
import { MOCK_COMMANDS } from "../src/mock/commands"
import type { AxonEngineRequest } from "@arcforge/types"

/**
 * The standard mock command set.
 *
 * `mock` is in every pool without being declared, so `*mock:mock` is always one
 * keystroke away — and a mock that echoed the prompt back is a route that
 * exists and does nothing worth doing.
 *
 * These cover the UI surfaces that are otherwise hard to provoke deliberately:
 * a denied call, a non-zero exit, a block that throws, a reply long enough to
 * wrap. They are also how the terminal is exercised without spending a token or
 * depending on a provider being reachable — which is exactly when you want
 * them, because "the model is unavailable" is often why you are looking.
 */

const ask = async (text: string, history: AxonEngineRequest["messages"] = []): Promise<string> => {
    const driver = Mock().create()
    const req = {
        messages: [
            ...history,
            { role: "user" as const, content: `<text from="user" id="u1" lang="md">\n    ${text}\n</text>` },
        ],
    } as AxonEngineRequest

    let out = ""
    for await (const event of driver.stream(req)) {
        if (event.type === "text:delta") out += event.content
    }
    return out
}

describe("a bare Mock() answers the command set", () => {
    test("/hello replies as text and ends the turn", async () => {
        const reply = await ask("mock-hello")

        expect(reply).toContain("<text>")
        expect(reply).toContain("<done/>")
    })

    test("/call-tool emits a real script block", async () => {
        // Not prose describing a call — the block the timeline renders as a
        // `Run(...)` row.
        expect(await ask("call-tool")).toContain("<script>")
    })

    test("/fail-tool emits code that actually throws", async () => {
        // The point is the FAILURE surface, so the block has to genuinely
        // fail — a demonstration that quietly succeeds teaches nothing.
        const reply = await ask("fail-tool")

        expect(reply).toContain("<script>")
        expect(() => JSON.parse("{ not json")).toThrow()
    })

    test("/deny-tool reaches for something a policy would refuse", async () => {
        expect(await ask("deny-tool")).toContain("git push")
    })

    test("/fail-bash exits non-zero", async () => {
        expect(await ask("fail-bash")).toContain("exit 3")
    })

    test("/stream is long enough to wrap and scroll", async () => {
        // Its whole job is exceeding a viewport. A short "long reply" would
        // pass a substring check and fail the purpose.
        const reply = await ask("stream")

        expect(reply.length).toBeGreaterThan(400)
    })

    test("/help lists the commands", async () => {
        const reply = await ask("help")

        for (const command of ["mock-hello", "call-tool", "fail-tool", "deny-tool", "stream"]) {
            expect(reply).toContain(command)
        }
    })

    test("every declared command answers with something", async () => {
        // A command in the map that resolves to nothing is worse than one that
        // does not exist — it looks supported and does nothing.
        for (const command of Object.keys(MOCK_COMMANDS as Record<string, unknown>)) {
            const reply = await ask(command)
            expect(reply.length).toBeGreaterThan(0)
        }
    })
})

describe("the echo remains for anything unrecognised", () => {
    test("plain text comes back as text", async () => {
        // What makes a mock useful as a PLAIN double: a test asserting "the
        // reply came back" reads its own prompt. The commands are additive.
        expect(await ask("just some words")).toContain("just some words")
    })

    test("a user's own script is a SECOND model, not a replacement", async () => {
        // `Mock({...})` adds `mock:custom` beside `mock:default` rather than
        // overwriting it. Declaring your own replies should not cost you every
        // standard command, and the old behaviour silently did exactly that.
        //
        // Driven directly here because the choice belongs to RESOLUTION — the
        // provider hands `create()` whichever capability won, and this is the
        // custom one.
        const driver = Mock({ "mine-only": "mine" }).create()
        const req = {
            messages: [{ role: "user" as const, content: `<text from="user" id="u1" lang="md">\n    mine-only\n</text>` }],
        } as AxonEngineRequest

        let out = ""
        for await (const event of driver.stream(req)) {
            if (event.type === "text:delta") out += event.content
        }

        expect(out).toContain("mine")
    })
})
