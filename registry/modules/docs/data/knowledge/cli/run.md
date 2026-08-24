---
title: axon run
---

# axon run

One execution: an agent, an instruction, go. The agent boots, the instruction runs to
completion, the agent exits. No TUI, no conversation.

```bash
axon run -a <agent> -p <prompt>              # a prompt the agent declares
axon run -a <agent> -s <script>              # a script the agent declares
axon run -a <agent> --text "<instruction>"   # a literal instruction
```

Both arguments are named rather than inferred. An earlier version took only a prompt and
resolved the agent from the working directory — fine for a human standing in a folder,
wrong for everything else. Cron entries, git hooks, CI steps and Axon Fleet all know
*which* agent they want and are not standing anywhere.

Naming both also makes an invocation quotable: the same line runs from a crontab, from an
issue comment, or six months later.

## The agent

`-a` (or `--agent`) takes a path or a bare name:

```bash
axon run -a ./agents/scout -p audit        # a path
axon run -a barry.mk3 -p audit             # a name under your active profile
```

A bare name resolves against the active profile only — it never searches other profiles.
Omitting `-a` falls back to the working directory, which is the convenient form when you
are already inside an agent.

## The instruction

Three flags, deliberately distinct. Exactly one is required; passing more than one is an
error.

**`-p` / `--prompt`** is a *reference*. It is resolved and, for a `.vue` prompt, rendered —
`<script setup>` runs and any declared props are filled from the remaining flags.

```bash
axon run -a barry.mk3 -p scout
axon run -a barry.mk3 -p learn --domain tracing
axon run -a barry.mk3 -p @cody/eslint-scout:scout   # an installed prompt package
```

Installed prompts are namespaced by their package, so they cannot shadow one you wrote.
See [Capabilities](/docs/v2/agent/build/capabilities).

**`-s` / `--script`** invokes one of the agent's own scripts, from `src/scripts/`.
Remaining flags arrive as its `args`.

```bash
axon run -a barry.mk3 -s close-plan --issueId bd-yiq
```

This is the one that is not an instruction. `-p` and `--text` both produce text for the
agent to act on; `-s` hands control to the agent's code, which decides what to do and
whether to invoke the loop at all. Nothing is streamed for you — a script writes its own
output.

**`--text`** is a *literal*, used verbatim.

```bash
axon run -a barry.mk3 --text "Audit the org boundary and report what you find."
```

They stay separate because collapsing them would mean guessing whether `"scout"` is a
prompt name, a script name, or a one-word instruction — and the guess is wrong exactly
when it matters.

## Arguments

Any flag other than the ones above becomes a prompt argument, available inside a rendered
prompt via `defineProps<{}>()`:

```bash
axon run -a barry.mk3 -p learn --domain tracing --depth 3
```

```vue
<script setup lang="ts">
defineProps<{ domain: string; depth?: string }>()
</script>
```

A script receives the same flags as its `args`:

```bash
axon run -a barry.mk3 -s close-plan --issueId bd-yiq
```

```ts
// src/scripts/close-plan.ts
const { issueId } = defineArgs<{ issueId: string }>()
```

Arguments are ignored by `--text`, which has nothing to render.

## Correlating a run with a job

`--job` tags the run with the job directory it belongs to:

```bash
axon run -a barry.mk3 --text "Propose the upgrade" --job .repo/jobs/update-typescript
```

This is **correlation only**. It does not change what is executed, load the job's brief, or
write anything back — it records the association in the run's liveness record so a reader
(Axon Fleet, another CLI invocation) can match a live agent to the work item it is
answering, rather than inferring it from timing.

## Output

Agent text streams to stdout as it arrives, so a piped or CI caller sees progress.
Everything else — tool calls, kernel telemetry, the full causal record — goes to the
session log under `data/sessions/`, where the console and `axon logs` read it.

If the instruction calls `axon.ui.ask()`, it receives `unavailable`: there is no connected
host to answer.

## Errors

| Error | Meaning |
|---|---|
| `RUN_INSTRUCTION_REQUIRED` | Neither `-p` nor `--text` was given |
| `RUN_INSTRUCTION_AMBIGUOUS` | Both `-p` and `--text` were given |
| `PROMPT_NOT_FOUND` | The agent declares no prompt by that name; the available ones are listed |
| `NOT_AN_AGENT` | The resolved project is a module, bench or cognet |

---

See [prompts/](/docs/v2/agent/src/prompts) for authoring the instructions `-p` resolves,
and [Scripts](/docs/v2/agent/src/scripts) for automation that composes several
invocations.

## Scripts that boot their own agents

`axon run` always names one agent. A global `*.axon.ts` script boots its own — possibly
several — so it has a separate verb:

```bash
axon exec ./review.axon.ts
```

See [axon exec](/docs/v2/cli/exec).
