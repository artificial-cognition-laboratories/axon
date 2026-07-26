# subagent

Subagent spawning for Axon agents. Without this module, an agent has no way to delegate work to a subagent — installing it is what grants that capability.

## Install

```bash
axon module install subagent
```

## Setup

No environment variables required. Subagent spawning runs through the agent's own capsule — no external service to configure.

## Usage

```ts
import { subagents } from "@axon/subagent"

const answer = await subagents.request("Summarize the last 10 commits on this repo")
```

## API

### `subagents.request(prompt)`

Spawns a fresh subagent with `prompt` as its task, runs it to completion, and returns its final text output.

**Parameters**

- `prompt` — the task to hand to the subagent

**Returns**

`string` — the subagent's final response text.

## Permissions

This module makes no outbound network requests of its own — it delegates to the parent agent's capsule, which handles subagent execution internally.
