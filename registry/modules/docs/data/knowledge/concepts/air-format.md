---
title: AIR Format
---

# AIR Format

AIR — Agent Intermediate Representation — is the format used to construct the context
window that gets sent to the model on every loop tick. It is an open standard, independent
of any model provider, and used by every Axon agent regardless of which engine is
configured.

**You do not manage AIR.** Everything in the format except the `<system>` block is
injected automatically by the runtime from the agent's runtime state — tool
declarations, process snapshots, session history, output contracts. You write prompts and
tools; the runtime assembles the context. This page is for engineers who are curious about
what the model actually sees.

## Why a format

Every LLM API expects messages — a flat array of `{role, content}` pairs. That shape
comes from chat product UIs, not from agent architecture. It has no concept of tools,
process state, causal timelines, or output contracts.

AIR is the layer between the agent's internal world and what the model receives. Instead
of hand-crafting message arrays, systems write typed entries into the agent's state. AIR
renders those entries into a structured, deterministic context window. The model never
sees raw agent internals — only the AIR projection.

This decouples context window construction from agent behaviour. When context assembly
improves, the agent gets better automatically. Nothing about the agent's tools, prompts,
or scripts changes.

## Structure

A rendered AIR context window is a sequence of typed blocks assembled in a fixed order:

| Block | Who writes it | Purpose |
|---|---|---|
| `<meta>` | Axon | Format preamble — tells the model how to read the context |
| `<env>` | Axon | Execution environment — tool namespaces, live processes, subagents |
| `<system>` | **You** | Your agent's identity and instructions — rendered from `boot.vue` and loaded prompts |
| `<contract>` | Runtime | Output grammar — which response modes the model is permitted to use |
| `<state>` | Runtime | Session state — current truth assembled from the agent's runtime state |
| `<timeline>` | Runtime | The causal turn sequence — everything that has happened, in order |

## The environment block

`<env>` declares the agent's execution environment. The `<scope>` contains TypeScript
declarations for every tool namespace in scope — what the agent can call and how.

```xml
<env>
    <scope lang="ts">
        declare namespace fs {
          /** Read a file as UTF-8 text. */
          export declare function read(path: string): Promise<string>;
          /** Write content to a file. */
          export declare function write(path: string, content: string): Promise<{ bytes: number }>;
        }

        declare const process: {
          run(command: string, opts?: { cwd?: string }): Promise<{ ok: boolean; stdout: string; stderr: string }>
        }
    </scope>
</env>
```

Live subprocesses and spawned subagents appear here too — the agent sees their status
and output at the point the context was constructed.

## The timeline

The timeline is not a chat log. It is a causal sequence of typed turns — everything that
has happened in the current session, in order. User messages, agent text, executed code,
stdout results, system notes.

```xml
<timeline>
    <user id="u1">
        can you add a sum() function to testing-ground/sum.js and run the tests?
    </user>

    <agent>
        <typescript id="e1">
            const content = await fs.read("testing-ground/sum.js")
            content
        </typescript>
    </agent>

    <stdout for="e1" ok="true">
        read  testing-ground/sum.js  67B
        function add(a, b) {
          return a + b
        }

        module.exports = { add }
    </stdout>

    <agent>
        <typescript id="e2">
            const result = await fs.edit("testing-ground/sum.js", [
              { op: "insertAfter", find: "module.exports = { add }", content: "\nfunction sum(numbers) {\n  return numbers.reduce((total, n) => total + n, 0)\n}\n" },
              { op: "replace", find: "module.exports = { add }", replace: "module.exports = { add, sum }" },
            ])
            result
        </typescript>
    </agent>

    <stdout for="e2" ok="true">
        fs.edit  {"ops":[{"ok":true,"count":1},{"ok":true,"count":1}]}  ✓
    </stdout>

    <agent>
        <text>
            Done. Added `sum(numbers)` — reduces the array left-to-right. Tests pass.
        </text>
    </agent>

    <user id="u2">
        nice — what port is the dev server on?
    </user>
</timeline>
```

Tool calls and their results appear inline at the point they occurred. The model sees the
full causal chain: what it decided, what ran, what came back. This is what enables
coherent multi-step work — the model reasons over what actually happened, not an
abstracted summary.

## The contract

The `<contract>` block declares which output modes the model is permitted to use in its
response. The model doesn't decide its output format — the contract does.

```xml
<contract>
    ## Blocks

    - `<typescript>` — TypeScript executed immediately. Tool namespaces are in scope.
    - `<text>` — Plain language communication to the user.
    - `<done/>` — signals the task is fully complete.

    ## Rules

    - Every word of output must be inside a block. No text outside XML tags — ever.
    - After an executable block — stop. The runtime executes your code and returns output.
    - After a `<text>` block with nothing left to do — emit `<done/>`.

    ## Examples

    Acting:
    ```
    <typescript>// code here</typescript>
    ```
    Communicating:
    ```
    <text>message here</text>
    ```
    Task complete:
    ```
    <text>summary here</text><done/>
    ```
</contract>
```

When the model responds outside the declared modes, that is a format violation. The
runtime detects it, injects an `<error>` entry into the next tick's timeline, and the
model self-corrects.

## The state block

`<state>` carries arbitrary structured context — the current truth of the world at the
time the context was constructed. Each item has a name and an optional language hint for
rendering.

```xml
<state>
    <cwd lang="txt">
        /home/cody/git/my-agent
    </cwd>
    <plan lang="json">
        [
          { "step": 1, "task": "Read package.json", "done": true },
          { "step": 2, "task": "Add sum() function", "done": false }
        ]
    </plan>
</state>
```

If `<state>` and `<timeline>` conflict, the model trusts `<state>`. State is resolved
truth; the timeline is historical record.

## What the model receives

At the LLM API level, AIR renders to a flat `messages` array — `system` and `user` roles,
plain string content. The model doesn't know it's reading AIR. It receives a
well-structured context and produces output in the declared format.

The AIR rendering layer handles:
- Block ordering and assembly
- Timeline compression when context budget is exceeded
- Format error injection for self-correction
- Live process state merging into the env block

## Inspecting context

Every rendered context window is emitted as an event in the session trace — stored in
`data/sessions/`. When debugging unexpected model behaviour, reading the context event for
that tick shows exactly what the model saw.

```bash
# tail the session trace for the last run
cat data/sessions/<session-id>.jsonl | grep air:context
```

---

**[Agent Output](/docs/v2/concepts/agent-output)** — the output side: what the model
emits, how TypeScript blocks execute in the capsule, and how results feed back into the
timeline.
