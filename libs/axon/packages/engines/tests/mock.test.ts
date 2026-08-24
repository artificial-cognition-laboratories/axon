import { Mock, run, extractUserText } from "../src/mock"
import type { AxonEngineRequest, AxonEngineResponse, EngineCloud } from "@arcforge/types"

/** Mock never touches the cloud — an unconnected stub keeps the contract honest. */
const cloudStub: EngineCloud = {
    user: { vault: { connections: {
        openai: { token: () => Promise.reject(new Error("VAULT_NOT_CONNECTED: test stub")) },
        openrouter: { token: () => Promise.reject(new Error("VAULT_NOT_CONNECTED: test stub")) },
    } } },
    cloud: {
        engine: {
            // eslint-disable-next-line require-yield
            async *stream(): AsyncGenerator<never> {
                throw new Error("cloud.engine.stream: test stub")
            },
            request: () => Promise.reject(new Error("cloud.engine.request: test stub")),
        },
    },
}

// Mimics the shape the real AIR renderer produces: every prior agent turn
// (spoken or executed) is wrapped in an <agent> tag, whatever tag is inside
// it. Mock's sequence tracking counts <agent> occurrences after the last
// <user> turn, so the fixture must reproduce that wrapping — not Mock's own
// wire format (`<text>...</text>` / `<typescript>...</typescript>`), which
// is a different, unrelated string.
function userRequest(content: string): AxonEngineRequest {
    return { messages: [{ role: "user", content: `<user id="u1">${content}</user>` }] }
}

async function call(input: Parameters<typeof Mock>[0], req: AxonEngineRequest): Promise<AxonEngineResponse> {
    const driver = Mock(input).create({ env: {}, cloud: cloudStub })
    let response: AxonEngineResponse | undefined
    for await (const event of driver.stream(req)) {
        if (event.type === "done") response = event.response
    }
    if (!response) throw new Error("driver stream ended without a done event")
    return response
}

/** Appends one <agent> turn to simulate the loop rendering the prior tick's output before calling again. */
function nextTick(req: AxonEngineRequest, _prior: AxonEngineResponse): AxonEngineRequest {
    const last = req.messages.at(-1)!
    return { messages: [...req.messages.slice(0, -1), { ...last, content: last.content + "<agent></agent>" }] }
}

describe("Mock engine", () => {
    it("with no input, echoes the user's message as spoken text", async () => {
        const response = await call(undefined, userRequest("hello"))

        expect(response.text).toBe("<text>hello</text><done/>")
    })

    it("with a map input, returns the matched reply for a substring match", async () => {
        const response = await call({ hello: "Hi there!" }, userRequest("hello world"))

        expect(response.text).toBe("<text>Hi there!</text><done/>")
    })

    it("with a map input, matches case-insensitively", async () => {
        const response = await call({ hello: "Hi there!" }, userRequest("HELLO WORLD"))

        expect(response.text).toBe("<text>Hi there!</text><done/>")
    })

    it("with a map input, falls back to echo when nothing matches", async () => {
        const response = await call({ hello: "Hi there!" }, userRequest("something else"))

        expect(response.text).toBe("<text>something else</text><done/>")
    })

    it("with a function input, runs the function and speaks its plain string result", async () => {
        const response = await call((req) => `You said: ${extractUserText(req)}`, userRequest("cool"))

        expect(response.text).toBe("<text>You said: cool</text><done/>")
    })

    it("with a function input returning run(), executes code instead of speaking", async () => {
        const response = await call(() => run("math.add(1, 2)"), userRequest("run code"))

        expect(response.text).toBe("<typescript>math.add(1, 2)</typescript>")
    })

    it("a sequence reply steps through each entry in order across successive calls", async () => {
        const input = { "/run": [run("1 + 1"), "the answer is above"] }

        const first = await call(input, userRequest("/run"))
        expect(first.text).toBe("<typescript>1 + 1</typescript>")

        const second = await call(input, nextTick(userRequest("/run"), first))
        expect(second.text).toBe("<text>the answer is above</text><done/>")
    })

    it("a sequence of text steps continues the loop until the last one, then repeats it once exhausted", async () => {
        const input = { "/run": ["first", "second"] }

        let req = userRequest("/run")
        const first = await call(input, req)
        req = nextTick(req, first)
        const second = await call(input, req)
        req = nextTick(req, second)
        const third = await call(input, req)

        // Only the sequence's actual last step terminates — a non-final
        // text step must continue the loop, same as a run() step, or a
        // multi-turn conversation ("hi" then "how are you?") could never
        // get past its first line.
        expect(first.text).toBe("<text>first</text>")
        expect(second.text).toBe("<text>second</text><done/>")
        expect(third.text).toBe("<text>second</text><done/>")
    })

    it("a multi-turn conversation of all-text steps runs every turn before stopping", async () => {
        const input = { "/conv": ["hi there!", "how are you?", "what's up?"] }

        let req = userRequest("/conv")
        const first = await call(input, req)
        req = nextTick(req, first)
        const second = await call(input, req)
        req = nextTick(req, second)
        const third = await call(input, req)

        expect(first.text).toBe("<text>hi there!</text>")
        expect(second.text).toBe("<text>how are you?</text>")
        expect(third.text).toBe("<text>what's up?</text><done/>")
    })

    it("a run() step never emits <done/>, even as a sequence's last step", async () => {
        const input = { "/tool": [run("console.log('hello')")] }

        const response = await call(input, userRequest("/tool"))

        expect(response.text).toBe("<typescript>console.log('hello')</typescript>")
    })

    it("streams spoken text as word-boundary deltas before the terminal done event", async () => {
        const driver = Mock(() => "two words").create({ env: {}, cloud: cloudStub })
        const events = []
        for await (const event of driver.stream(userRequest("hi"))) events.push(event)

        const deltas = events.filter(e => e.type === "text:delta")
        expect(deltas.length).toBeGreaterThan(0)
        expect(events.at(-1)?.type).toBe("done")
    })

    it("reports stopReason 'end' without fabricating unavailable usage", async () => {
        const response = await call(undefined, userRequest("hi"))

        expect(response.stopReason).toBe("end")
        expect(response.meta.provider).toBe("mock")
        expect(response.meta.tokens).toBeUndefined()
    })
})

describe("Mock engine: extractUserText", () => {
    it("pulls the innermost <user> turn out of an AIR timeline", () => {
        const req: AxonEngineRequest = {
            messages: [{ role: "user", content: `<meta></meta><timeline><user id="u1">the real message</user></timeline>` }],
        }

        expect(extractUserText(req)).toBe("the real message")
    })

    it("returns raw content when it isn't AIR-formatted", () => {
        const req = userRequest("plain content")

        expect(extractUserText(req)).toBe("plain content")
    })
})
