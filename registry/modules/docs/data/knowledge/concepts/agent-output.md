---
title: Agent Output
---

# The agent speaks TypeScript

Most tool-calling systems use a structured protocol: the model emits a JSON object with a
function name and arguments, the framework deserializes it, looks the function up in a
registry, calls it, and serializes the result back. There's a translation layer at every
step.

Axon does not work this way.

The model emits TypeScript. The capsule runs it. The stdout comes back as the next entry
in the timeline.

## The output surface

The agent has exactly two output variants, both defined in the `<contract>` block of the
AIR context window:

**`<typescript>`** — executable code. Emitted when the agent needs to act on the
environment. Runs immediately in the capsule. The runtime stops and waits for the result
before continuing the loop.

**`<text>`** — plain language. Emitted when the agent is communicating with the user.
Not executed. Streamed directly to output.

That's the entire surface. There is no third mode, no hybrid, no escape hatch.

## What happens when the agent acts

When the model emits a `<typescript>` block:

1. The runtime passes the block to the capsule subprocess
2. The capsule runs the code against the declared tool namespaces
3. Stdout is captured and returned as a `<stdout for="..." ok="true|false">` entry
4. That entry is injected into the next tick's timeline
5. The loop continues — the model reads the result and decides what to do next

The model never calls functions directly. It writes code that calls functions. The capsule
executes that code on the user's machine, in the user's filesystem, under the policy
declared in `axon.config.ts`.

## Tools as TypeScript declarations

Every tool available to the agent is declared as a TypeScript namespace in the `<env>`
block:

```xml
<env>
    <scope lang="ts">
        declare namespace fs {
          export declare function read(path: string): Promise<string>;
          export declare function write(path: string, content: string): Promise<{ bytes: number }>;
          export declare function list(path: string): Promise<Array<{ name: string; type: "file" | "directory" }>>;
        }

        declare const process: {
          run(command: string, opts?: { cwd?: string }): Promise<{ ok: boolean; stdout: string; stderr: string }>
        }
    </scope>
</env>
```

The model sees typed declarations. It writes code against those types. When the code
runs, the implementations behind the declarations are the actual tool functions you
defined in `src/tools/` — plus any contributed by installed modules.

The type contract is structural, not bolted on. The model isn't guessing at argument
shapes from a description. It has the exact signatures, return types, and JSDoc that you
wrote.

## High-bandwidth, composable execution

Because the output is code, the agent can compose freely within a single turn. Multiple
tool calls in one block is the default — not the exception.

```typescript
// One turn. One stdout. No round-trips.
const [src, pkg, config] = await Promise.all([
    fs.read("src/index.ts"),
    fs.read("package.json"),
    fs.read("axon.config.ts"),
])
// Last expression is the stdout returned to the loop
src
```

Parallel reads, conditional logic, multi-step operations — all in one `<typescript>`
block. The agent only splits into a new turn when the result of one operation genuinely
determines what the next operation must be. Everything else can and should compose.

This is the high-bandwidth channel. A single turn can read dozens of files, run commands,
apply edits, and inspect results. The loop doesn't tick again until there's a real data
dependency.

## The capsule runs on the user's machine

The capsule is a subprocess on the machine running the agent — not a cloud sandbox, not
a remote interpreter. When the agent calls `fs.read("src/index.ts")`, that's a real file.
When it calls `process.run("bun test")`, that's a real process.

For the full picture of what the capsule makes available — subprocesses, subagents, the
complete Bun runtime — see [The Agent's World](/docs/v2/concepts/agents-world).

## Format violations and self-correction

The `<contract>` block is not a prompt instruction. It is the only output grammar the
runtime accepts. If the model emits content outside a declared block — any text not
wrapped in `<typescript>` or `<text>` — the runtime flags it as a format violation.

The violation is injected into the next tick's timeline as an `<error>` entry. The model
reads it and corrects. The loop does not break — self-correction is built into the cycle.

This is why the contract is part of every context window rather than a one-time setup
instruction. The model is reminded of its output grammar on every tick. Format discipline
is structural, not reliant on the model following instructions it received earlier.

---

**[AIR Format](/docs/v2/concepts/air-format)** — the full input side: what the model
receives on every tick, and how that context is assembled.

**[The Agent's World](/docs/v2/concepts/agents-world)** — the complete execution
environment: tool namespaces, subprocesses, subagents, and the full Bun runtime.
