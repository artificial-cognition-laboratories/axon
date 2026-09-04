---
title: tests/
icon: vscode-icons:folder-type-test
---

# tests/

Put test files in `tests/`. Same runner as agent tests — `bun:test`, with the `Axon()`
harness available as a global. The difference: you are not testing the module in
isolation. Modules have no standalone runtime. You boot a parent agent with the module
loaded and test the contribution surface — what tools appeared, what prompts render,
how hooks behave.

```bash
tests/
├── hooks.test.ts
├── prompts.test.ts
└── tools.test.ts
```

## The harness

Run tests from inside an agent that has your module installed. The harness boots that
agent's full runtime — your module's `setup()` runs, its tools are registered, its
prompts are available.

```ts
import { Mock } from "@arcforge/engines/mock"

describe("discord module", () => {
    it("registers the discord tool namespace", async () => {
        const runtime = await Axon({
            blueprint: { config: { providers: [Mock()] } },
        })

        expect(runtime.axon.tools.discord).toBeDefined()

        await runtime.shutdown()
    })
})
```

## Testing the tool surface

Verify that the tools your module declares are present and callable. Call them directly
via `runtime.axon.tools.*` — no agent loop involved, just the function.

```ts
it("queue returns empty state when nothing is playing", async () => {
    const runtime = await Axon({ blueprint: { config: { providers: [Mock()] } } })

    const state = await runtime.axon.tools.discord.queue(guildId)
    expect(state).toEqual({ current: null, upcoming: [] })

    await runtime.shutdown()
})
```

Tools that depend on external connections (Discord client, databases, IMAP) will throw
in test environments where those services aren't present. Test the logic you control —
state management, return shapes, guard conditions — not the external service.

## Testing prompts

Render the prompts your module contributes and assert on their content. This catches
template regressions — broken variable interpolation, missing sections, stale copy.

```ts
it("renders the discord prompt with required props", async () => {
    const runtime = await Axon({ blueprint: { config: { providers: [Mock()] } } })

    const prompt = await runtime.axon.prompt("discord", {
        content: "hello",
        username: "cody",
        channelId: "123",
    })

    expect(prompt.content).toContain("cody")
    expect(prompt.content).toContain("hello")

    await runtime.shutdown()
})
```

Test the dynamic cases — prompts that branch on data. If your prompt surfaces
now-playing state conditionally, assert it appears when the data is present and
doesn't when it isn't.

## Testing hooks

Your module emits hooks — fire them directly via `callHook()` and assert on the
outcome. This is how you test the full path: hook fires, agent processes it, callback
receives a reply.

```ts
it("fires a reply when a message hook is triggered", async () => {
    const runtime = await Axon({
        blueprint: { config: { engine: Mock({ "": "hey cody" }) } },
    })

    let replied: string | null = null
    await runtime.axon.hooks.callHook("discord:message.received", {
        content: "hello barry",
        username: "cody",
        reply: async (text: string) => { replied = text },
    })

    expect(replied).toBe("hey cody")

    await runtime.shutdown()
})
```

## Testing tool calls through the loop

When the agent should respond to a message by calling one of your module's tools,
script the model with a sequence — one step per loop tick. The tool genuinely executes
in the capsule; the second tick sees its result and speaks.

```ts
import { Mock, run } from "@arcforge/engines/mock"

it("agent calls play tool when asked", async () => {
    const runtime = await Axon({
        blueprint: {
            config: {
                engine: Mock({
                    "play something": [
                        run(`discord.play("track", userId, guildId)`),
                        "Now playing.",
                    ],
                }),
            },
        },
    })

    const result = await runtime.axon.request("play something")
    expect(result.text).toBe("Now playing.")

    await runtime.shutdown()
})
```

## Running tests

Run from inside the agent directory that has your module installed:

```bash
bun test
bun test tests/hooks.test.ts
bun test --watch
```
