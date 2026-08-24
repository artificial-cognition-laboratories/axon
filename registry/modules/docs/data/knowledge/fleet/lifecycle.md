---
title: Lifecycle
---

# Lifecycle

How a string becomes a running agent, and what happens when the run ends.

```
axon exec review.axon.ts
  │
  ├─ resolve every reference     ← fails here if an agent is missing
  ├─ boot in parallel            ← capsules start, modules connect
  ├─ run the script              ← your code
  └─ shut everything down        ← always, including on failure
```

## Resolving a reference

Every agent reference is a string, and one resolver turns it into a directory.

```ts
await Fleet({
    barry: "../barry",           // a path, relative to the script
    dave:  "~/agents/dave",      // a path, absolute
    scout: "scout",              // a name — your profile, then watched paths
    zeno:  "@axon/zeno",         // a registry package
})
```

A reference starting `.`, `~`, `/` or containing a slash is a **path**, resolved against
**the script's own directory** — not where you invoked from, which is what keeps a script
portable. If nothing is there it throws: a path states where the agent is, so a miss is a
mistake, not an invitation to go looking.

Anything else is a **name**, resolved in order: your profile's agents, then each
[`axon watch`](/docs/v2/cli/watch) root, then — for a scoped package — the registry, which
fetches and installs it for next time. First match wins, so a local copy always shadows a
published one.

```bash
axon watch ~/agents          # make everything under here addressable by bare name
axon install @axon/zeno      # resolve and cache ahead of time, so no run pays for it
```

Pin a version (`"@axon/zeno@1.4.0"`) when you need an agent to stay put. Unpinned resolves
to whatever is installed, and fetches the latest if nothing is.

Resolution completes for the whole set before anything boots. A fleet comes up whole or
not at all — a script holding two working agents and one broken one is the outcome this
prevents.

## Teardown

`axon exec` owns the process. When the script finishes — returns, throws, or is
interrupted — every agent it booted is shut down, then it exits.

This is why destructuring is safe. `const { barry, checker } = await Fleet(...)` throws
away the fleet object, which in most APIs would mean throwing away the only way to clean
up. Here the lifetime belongs to the run.

Shutdown is error-isolated — one agent failing to close never strands the others — and
session logs flush regardless, so a crashed run still leaves a complete trace per agent.

## What survives

The runtime is ephemeral; the folder is not.

Each agent writes its session to its own `data/sessions/` as a JSONL trace. Three agents
leave three traces, in three folders, each readable on its own. Anything written to
`data/` during the run persists on the same terms.

Conversation does not survive. A handle's context lasts as long as the handle: within a
run consecutive calls share everything, across runs they share nothing. If an agent needs
to carry something forward it belongs in `data/` — written deliberately, read at boot. See
[State & Memory](/docs/v2/concepts/state-model).

## Long-running scripts

Nothing stops a script staying up — a loop, a queue consumer, a watcher. Boot once at the
top and keep the handles:

```ts
const { triage } = await Fleet({ triage: "../triage" })

for await (const issue of watchIssues()) {
    const result = await triage.request(`triage this issue:\n\n${issue.body}`)
    await postComment(issue.number, result.text)
}
```

One boot, many requests, one context accumulating across every issue. When that
accumulation is wrong — issue nine should not be coloured by issue eight — the answer is a
fresh instance per unit of work, not a longer prompt.

## When a script becomes an agent

A global script is disposable by design: no identity, no version, no address. When it
earns its keep — a teammate wants it, it should run nightly, it needs an HTTP endpoint —
it becomes an agent whose job is orchestrating other agents.

```
eslint-manager/
├── src/scripts/audit.ts     # boots a fleet, runs the audit
├── src/prompts/
└── axon.config.ts
```

There is no separate workflow artifact, and there doesn't need to be. A manager is an
ordinary agent that happens to delegate, so everything built for agents applies unchanged:

| | How |
|---|---|
| Publish / install | `axon publish`, `axon install @cody/eslint-manager` |
| Deploy | `axon deploy` — routes, URL, API key |
| Schedule | cron against a script or a route |
| Trigger | HTTP routes, hooks, email, the TUI palette |
| Observe | its own session trace, like any agent |

It can also *think*. A script routes work by whatever its author hardcoded; a manager can
ask an agent which specialist should handle something, then boot that one. That is the
capability a plain script doesn't have.

A published manager can't use relative paths — the consumer has no `../linter` — so refer
to members by registry name, pinned.

## Agents already running

A booted agent serves HTTP, and its routes are the same front door for a browser, a
webhook, or another agent:

```ts
const res = await fetch(`${barryUrl}/api/chat`, {
    method: "POST",
    body: JSON.stringify({ message: "what's the status of the migration?" }),
})
```

Because the only way in is the protocol, location is a property of the address: an agent
your script booted, one running elsewhere on the machine, and a deployed one are reached
the same way. Moving an agent to the cloud changes its address, not the code that talks to
it. See [Connecting](/docs/v2/deploy/connecting).

A machine-wide directory of running agents — so an agent can look up where its peers are
rather than being told — is a natural extension of the state the CLI already tracks. It
hands out identity and address, not a handle: a directory, not a back door.

---

Next: [Managing Agents](/docs/v2/fleet/management) — the same fleet, in the editor.
