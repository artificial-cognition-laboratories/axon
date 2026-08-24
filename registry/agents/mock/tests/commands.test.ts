import { MockCommands } from "../src/mock/engine"
import { buildProvider } from "@arcforge/engines/providers"
import { commands } from "../src/mock/commands"
import type { AxonEngineRequest, AxonEngineResponse, EngineCloud } from "@arcforge/types"

/**
 * Drives the agent's engine the way the runtime drives it: build a request,
 * stream the driver, read what it produced, append the reply and go round
 * again for the multi-tick commands.
 *
 * This is the engine boundary, not a direct call into the command table —
 * a test that invoked `commands.log.turn({ tick: 0 })` would pass even if
 * dispatch were broken and would never see the `<done/>` behaviour that
 * decides whether the loop continues.
 *
 * It stops short of booting the full runtime because the documented
 * `Axon()` test harness is declared but never installed — see the entry in
 * libs/axon/platform/debt.md. When that is fixed these become runtime tests.
 */

/** Mock never reaches the cloud; an unconnected stub keeps the contract honest. */
const cloudStub: EngineCloud = {
    user: { vault: { connections: {
        openai: { token: () => Promise.reject(new Error("VAULT_NOT_CONNECTED: test stub")) },
        openrouter: { token: () => Promise.reject(new Error("VAULT_NOT_CONNECTED: test stub")) },
    } } },
    cloud: {
        engine: {
            // eslint-disable-next-line require-yield
            async *stream(): AsyncGenerator<never> { throw new Error("cloud.engine.stream: test stub") },
            request: () => Promise.reject(new Error("cloud.engine.request: test stub")),
        },
    },
}

function ask(text: string): AxonEngineRequest {
    return { messages: [{ role: "user", content: text }] }
}

async function once(req: AxonEngineRequest): Promise<AxonEngineResponse> {
    // MockCommands() is a ProviderEntry now, not an engine def — build the
    // provider from it the way resolution does, then take its driver. The
    // mock provider supplies exactly one capability and ignores the argument,
    // so resolving "mock" is the whole of capability selection here.
    const provider = buildProvider(MockCommands(), { env: {}, cloud: cloudStub })
    const capability = await provider.resolve("mock")
    if (!capability) throw new Error("mock provider did not resolve its own capability")
    const driver = provider.create(capability)
    let response: AxonEngineResponse | undefined
    for await (const event of driver.stream(req)) {
        if (event.type === "done") response = event.response
    }
    if (!response) throw new Error("driver stream ended without a done event")
    return response
}

/** Runs a message to completion, returning every tick's raw output. */
async function conversation(text: string, max = 60): Promise<string[]> {
    let req = ask(text)
    const ticks: string[] = []

    for (let i = 0; i < max; i++) {
        const response = await once(req)
        ticks.push(response.text)
        // <done/> is the model handing control back — the loop stops there.
        if (response.text.includes("<done/>")) return ticks
        req = { messages: [...req.messages, { role: "assistant", content: response.text }] }
    }

    throw new Error(`command did not terminate within ${max} ticks`)
}

describe("dispatch", () => {
    it("runs the command named by a leading slash word", async () => {
        const [reply] = await conversation("/hello")
        expect(reply).toContain("Hello world!")
    })

    it("echoes a message that is not a command", async () => {
        const [reply] = await conversation("just talking")
        expect(reply).toContain("just talking")
    })

    it("does not run a command merely mentioned inside prose", async () => {
        const [reply] = await conversation("what does /hello do")
        expect(reply).not.toContain("Hello world!")
        expect(reply).toContain("what does /hello do")
    })

    it("matches a command case-insensitively", async () => {
        const [reply] = await conversation("/HELLO")
        expect(reply).toContain("Hello world!")
    })

    it("shows help for an unrecognised slash word rather than failing", async () => {
        const [reply] = await conversation("/nonsense")
        expect(reply).toContain("/markdown")
    })

    it("ends every single-tick command in one turn", async () => {
        for (const name of ["hello", "markdown", "code", "wide", "unicode", "burst", "help"]) {
            const ticks = await conversation(`/${name}`)
            expect(ticks.length).toBe(1)
        }
    })
})

describe("loop shape", () => {
    it("takes the requested number of ticks for /loop", async () => {
        const ticks = await conversation("/loop 4")

        expect(ticks.length).toBe(4)
        expect(ticks[0]).toContain("Tick 1 of 4")
        expect(ticks[3]).toContain("Tick 4 of 4")
        // Only the final tick hands control back.
        expect(ticks[0]).not.toContain("<done/>")
        expect(ticks[3]).toContain("<done/>")
    })

    it("falls back to a default when /loop gets no usable argument", async () => {
        const ticks = await conversation("/loop five")
        expect(ticks.length).toBe(3)
    })

    it("clamps an absurd tick count rather than hanging", async () => {
        const ticks = await conversation("/loop 9999")
        expect(ticks.length).toBe(50)
    })

    it("acts on the first tick and speaks on the second for /log", async () => {
        const ticks = await conversation("/log")

        expect(ticks.length).toBe(2)
        expect(ticks[0]).toContain("<script>")
        expect(ticks[0]).toContain("console.log")
        expect(ticks[1]).toContain("<text>")
        expect(ticks[1]).toContain("<done/>")
    })

    it("acts then reports for /tool", async () => {
        const ticks = await conversation("/tool")

        expect(ticks.length).toBe(2)
        expect(ticks[0]).toContain("<script>")
        expect(ticks[0]).toContain("process.run")
    })

    it("emits a throwing script for /fail", async () => {
        const [reply] = await conversation("/fail")
        expect(reply).toContain("<script>")
        expect(reply).toContain("deliberate")
    })

    it("takes several speaking ticks for /think", async () => {
        const ticks = await conversation("/think 3")
        expect(ticks.length).toBe(3)
        expect(ticks.every(t => t.includes("<text>"))).toBe(true)
    })
})

describe("rendering", () => {
    it("speaks markdown constructs for /markdown", async () => {
        const [reply] = await conversation("/markdown")
        expect(reply).toContain("# Heading one")
        expect(reply).toContain("| Column | Meaning | Notes |")
    })

    it("speaks fenced code for /code", async () => {
        const [reply] = await conversation("/code")
        expect(reply).toContain("```ts")
        expect(reply).toContain("```python")
    })

    it("scales /long by its argument", async () => {
        const [short] = await conversation("/long 2")
        const [longer] = await conversation("/long 9")
        expect(short!.length).toBeLessThan(longer!.length)
        expect(short).toContain("Paragraph 2.")
    })

    it("delivers /slow one line per tick", async () => {
        const ticks = await conversation("/slow 5")
        expect(ticks.length).toBe(5)
    })
})

describe("help", () => {
    it("lists every command", async () => {
        const [reply] = await conversation("/help")
        for (const name of Object.keys(commands)) {
            expect(reply).toContain(`/${name}`)
        }
    })

    it("gives every command a summary", () => {
        for (const [name, command] of Object.entries(commands)) {
            expect(command.summary.length, `${name} has no summary`).toBeGreaterThan(0)
        }
    })
})
