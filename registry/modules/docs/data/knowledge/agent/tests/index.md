---
title: tests/
icon: vscode-icons:folder-type-test
---

# tests/

Put test files in `tests/`. They are standard Bun test files — `bun:test` for the
runner, with the `Axon()` harness available as a global. The harness boots the complete
agent runtime against your actual `axon.config.ts`, so you are testing the real thing.

```bash
tests/
├── behavior.test.ts
├── scripts.test.ts
└── tools.test.ts
```

## The harness

`Axon()` boots a full agent runtime scoped to the test — real kernel, real capsule,
real tools, real policy. Swap in `Mock()` as the engine so runs are deterministic and
free. Call `runtime.shutdown()` when you're done.

```ts
import { Mock } from "@arcforge/engines/mock"

describe("my agent", () => {
    it("responds to a request", async () => {
        const runtime = await Axon({
            blueprint: { config: { engine: Mock({ hello: "hi there" }) } },
        })

        const result = await runtime.axon.request("hello")
        expect(result.text).toBe("hi there")

        await runtime.shutdown()
    })
})
```

`runtime.axon` is the same handle available in scripts and routes. Same API, no special
test mode.

## The Mock engine

Real inference in tests is slow, nondeterministic, and costs money. `Mock()` replaces
it with a script you write — the full agent loop still runs. Tool calls execute, the
session log accumulates, stop conditions fire. Everything behaves as in production,
just without a model.

**Echo** — no input reflects the user's message back. Useful for testing routing and
wiring without caring about content:

```ts
engine: Mock()
```

**Map** — patterns matched as case-insensitive substrings against the last user
message. A reply is spoken text, or a sequence of steps consumed one per loop tick:

```ts
import { Mock, run } from "@arcforge/engines/mock"

engine: Mock({
    "sprint status": "Two issues remain in review.",
    "review the file": [
        run(`fs.read("src/index.ts")`),   // tick 1: the "model" acts
        "The file looks correct.",         // tick 2: it sees the result, then speaks
    ],
})
```

`run()` executes real code in the real capsule, under your real policy — the result
lands in the session log and the next tick sees it, exactly as in production.

**Function** — full control. Receives the engine request, returns the next step:

```ts
engine: Mock(async (req) => {
    const last = req.messages.at(-1)?.content ?? ""
    return `You said: ${last}`
})
```

See [Mock()](/docs/v2/agent/engines/mock) for the full reference.

## Asserting on results

`runtime.axon.request()` returns the final text and the full entry log for the call:

```ts
const result = await runtime.axon.request("run the test suite")

// Text of the agent's spoken output
expect(result.text).toContain("passed")

// Every entry the call produced, in commit order
expect(result.entries.some(e => e.type === "cognet:output:text")).toBe(true)
```

The whole session is also on the record — `runtime.session.entries` holds every entry
committed since boot, which is how you assert on what *actually happened* rather than
what was returned:

| Entry type | What it is |
|------|-----------|
| `cognet:stimulus:text` | Input arriving at the agent |
| `cognet:output:text` | The agent speaking |
| `cognet:action:typescript` | Code the agent ran |
| `cognet:action:result` | What came back |

## Testing tools directly

Tools are reachable without going through the loop at all — typed, real, policy-checked:

```ts
const runtime = await Axon({ blueprint: { config: { engine: Mock() } } })

const sum = await runtime.axon.tools.math.add(2, 3)
expect(sum).toBe(5)

await runtime.shutdown()
```

## Failure behaviour

The runtime fails loudly, and tests can assert on that:

```ts
it("rejects when no engine is configured", async () => {
    const runtime = await Axon()
    await expect(runtime.axon.request("hello")).rejects.toThrow(/No Engine Configured/)
    await runtime.shutdown()
})
```

## Config overrides

The `blueprint` merges over your `axon.config.ts` — override only what the test needs.
Swapping the engine is the common case; tools, prompts, and policy stay exactly as your
agent declares them.

## Running tests

```bash
bun test
bun test tests/tools.test.ts
bun test --watch
```

Tests run against your local agent. The capsule boots, tools load, and the runtime is
available for the duration of the test.
