# @arcforge/axond

## What This Is

The Axon daemon — one process per user, per machine, owning everything no
single agent can own.

Not an inference server. Inference is its first tenant, not its purpose. The
job is *"I am the one process on this box that holds shared state"*, and three
things need that:

- **machine** — the GPU. Two agents deciding independently that 6GB is free is
  how both take it.
- **agents** — every agent running here. A registry a terminal cannot outlive.
- **models** — one resident copy of a weight, however many agents hold it.

`schedule` is the fourth and is deliberately unwired: boot-time agents and
cron-style wakeups are the reason this is a daemon rather than a library, and
naming the domain now is what stops it arriving as a fifth concern bolted to
the side.

## The Design

**Two roots, one shape.** `Axond()` is the server-side composition root;
`AxonDaemon()` is the client handle. They expose the SAME four domains, which
is what lets the daemon be tested in-process without a socket — construct
`Axond()` and exercise it — while the transport is tested once, separately.

**Degraded, never blocked.** The daemon being down must not stop local agents
working. Every verb that needs it fails loudly naming the fix; the file-based
reservation protocol in `~/.axon/cache/resources` stays as the honest degraded
path, because every reader already reaps dead pids and works with no daemon at
all.

**The client handle IS the SDK.** `daemon.agents.at(id)` returns an instance
handle you can talk to, not a record you look things up in. That distinction
is why a future SDK is this surface with documentation rather than a
translation layer over an RPC shape.

**`control/` is transport, not a domain.** It is where the socket and the
lifecycle live. Putting it beside the four would make the surface lie about
what the daemon is.

## Key Interfaces

```typescript
const axond = Axond(opts)      // server: what bin/axond.ts boots
const daemon = AxonDaemon(opts) // client: what every consumer holds

daemon.machine.state()          // hardware, budget, what is held
daemon.agents.list()            // every agent on this machine
daemon.agents.at(id)            // one instance, as a handle
daemon.models.resident()        // what is loaded
```

## Known Debt

`models` and `schedule` are unwired and throw. See `debt.md`.
