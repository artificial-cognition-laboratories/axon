---
title: agents
---

# agents

Running instances. You **start by name** and then address **by instance** — one agent can
have many live instances, so a verb taking a name has no answer for "which one".

```ts
interface AgentsApi {
    // Reading.
    targets(): Promise<readonly AgentTarget[]>   // everything that can be started
    list(): readonly AgentInstance[]             // running, in spawn order
    get(id: string): AgentInstance | null
    focused(): AgentInstance | null

    // Lifecycle. Throws INSTANCE_NOT_RUNNING on an id nothing answers to.
    spawn(name: string): Promise<AgentInstance>   // always NEW, in the background
    focus(id: string): void
    stop(id?: string): Promise<void>     // omit id for the focused instance
    reboot(id?: string): Promise<void>   // omit id for the focused instance

    // Conversation.
    send(content: string): Promise<void>   // to the FOCUSED instance. Yields nothing.
    interrupt(): boolean
}

type AgentInstance = {
    readonly id: string        // stable; every verb addresses by this
    readonly name: string      // the project — several instances may share one
    readonly focused: boolean
    readonly activity: "booting" | "rebooting" | "shutting-down" | "working" | null
}

type AgentTarget = {
    readonly name: string
    readonly kind: "local" | "deployed"
    readonly instances: readonly AgentInstance[]   // most recently focused first
}
```

## Spawn, focus, send

```ts
const reviewer = await agents.spawn("@axon/reviewer")
agents.focus(reviewer.id)
await agents.send("review main")
```

`spawn` runs in the **background** and does not take the screen — a config booting two
agents would otherwise have them race for it, and neither asked to be looked at. It
returns the instance because `a.id !== b.id` for two spawns of the same agent: "the one I
just started" cannot be recovered from the name.

`send` targets whatever is **focused**, which is why the middle line is required.

## send yields nothing, deliberately

```ts
const reply = await agents.send("what changed?")   // void
```

An extension drives a conversation and never consumes one. Branching on model output is
an agent's job — build a [cognet](/docs/v2/cognets). Enforced by the type.

A send during a switch is queued for the agent **arriving**, not delivered to the one
being left.

## stop vs reboot

```ts
await agents.reboot(id)   // rescan + hot-swap. The conversation survives.
await agents.stop(id)     // the only verb here that ends a conversation.
```

Focusing never stops what you were on.

## Acting on what is running

```ts
commands.register("stop all", {
    async run() {
        const running = agents.list()
        if (!running.length) return tui.info("nothing running")
        if (!await palette.confirm(`Stop ${running.length} instances?`)) return

        for (const i of running) await agents.stop(i.id)
    },
    description: "Shut down every instance",
})
```

`list()` is spawn order and stable — a list you navigate must not reorder under the
cursor.

## interrupt

```ts
keys.register("ctrl+alt+x", () => {
    if (!agents.interrupt()) tui.warn("nothing to interrupt")
})
```

Stops the focused instance's current wake, as `Escape` does. Interrupted is a settled
outcome, not an error — nothing is lost from the conversation.

## An id is not a guarantee

```ts
if (!agents.get(savedId)) return   // it may have stopped on its own
agents.focus(savedId)
```
