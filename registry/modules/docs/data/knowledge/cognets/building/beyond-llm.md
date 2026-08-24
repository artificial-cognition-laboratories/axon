---
title: Cognition Beyond the LLM
description: Control loops, perception stacks, embodied agents — the same engine at a different fill rate.
---

# Cognition Beyond the LLM

Everything in this section so far has had no language model in it.

The loop, the clock, the world, the log, the telemetry — none of it assumes inference.
`kernel.stream()` is one verb of ten, and a cognet that never calls it is still a
cognet: same wake machinery, same phases, same durable record, same flame graph.

This page is what that buys.

## The same loop, twice

Here is `zero`, reduced to its shape:

```ts
loop(async ({ signal, stop }) => {
    await phase("sync", async () => sync())

    const messages = await phase("render", async () => renderContext(state))

    const { blocks, done } = await phase("invoke", async () => {
        return collectFrom(kernel.stream({ messages, signal }))
    })

    if (blocks.length > 0) {
        await phase("act", async () => { await kernel.run(blocks, { signal }) })
    }

    if (done && blocks.length === 0) stop()
})
```

And here is a PID controller:

```ts
loop(async ({ stop }) => {
    const { error, dt } = await phase("sense", async () => readSensor())

    const command = await phase("compute", async () => {
        state.integral += error * dt
        const derivative = (error - state.previous) / dt
        state.previous = error
        return Kp * error + Ki * state.integral + Kd * derivative
    })

    await phase("actuate", async () => {
        await kernel.output("cognet:output:field", {
            reading: { value: command, unit: "throttle" },
        })
    })

    stop()
})
```

Structurally identical. Both fold input, compute, emit. Both get tick and phase telemetry,
both are durable, both can be interrupted, both replay from the log.

The difference is entirely inside `compute`. One calls a model; one does arithmetic. The
engine cannot tell them apart, and that is the point.

## Models out of the hot loop

The interesting architectures aren't "an LLM in a loop" — they're pipelines where learned
components do specific jobs inside a system that mostly isn't learned.

A perception stack running at 125Hz cannot wait on a model. But it can run a fast
deterministic loop that *occasionally* escalates:

```ts
loop(async ({ stop }) => {
    const observation = await phase("perceive", async () => {
        return await system("fuse-sensors", async () => fuse(readAll()))
    })

    await phase("react", async () => {
        // the fast path — no inference, every tick
        await kernel.output("cognet:output:field", {
            reading: { value: reflex(observation), unit: "steering" },
        })
    })

    // the slow path — only when the fast path is out of its depth
    if (novel(observation) && !state.deliberating) {
        state.deliberating = true
        void deliberate(observation).finally(() => { state.deliberating = false })
    }

    stop()
})
```

The reflex runs every tick. Deliberation is kicked off without blocking, and its result
lands in `state` for a later tick to use. That's a two-rate mind — fast reflexes, slow
reasoning — and it's ordinary TypeScript because the engine has no opinion about what a
tick contains.

## Multiple engines, different jobs

Nothing says one cognet calls one model. `kernel.stream()` takes a request; a cognet can
make several, for different purposes, in different phases:

```ts
loop(async ({ signal, stop }) => {
    const plan = await phase("plan", async () => {
        return collectFrom(kernel.stream({ messages: planningContext(state), signal }))
    })

    const critique = await phase("critique", async () => {
        return collectFrom(kernel.stream({ messages: critiqueContext(plan), signal }))
    })

    if (critique.rejected) {
        state.rejections.push(critique)
        return   // next tick re-plans with the critique in context
    }

    await phase("act", async () => { await kernel.run(plan.blocks, { signal }) })
    stop()
})
```

A planner and a critic, each with its own context, in named phases you can profile
separately. The orchestration overhead that usually makes this painful — wiring, state
threading, observability, interrupt handling — is what the engine already provides.

## Embodied agents

An embodied agent needs three things the engine gives it directly.

**A clock**, because the world doesn't wait for a stimulus. That's continuous mode.

**Durability across power loss**, because a robot that only survives graceful shutdown
isn't deployable. The log-shaped mind is exactly this: `kill -9` costs nothing, and cold
boot is a fold from `-1`.

**An identity and a policy**, because an autonomous physical system should be a known
entity with an owner and enforced constraints. That's the Axon perimeter around the
cognet, not something the cognet has to implement.

The body arrives as a module. ROS topics become stimuli, actions become effects:

```ts
loop(async ({ stimuli, stop }) => {
    await phase("sense", async () => {
        for (const stimulus of stimuli) {
            foldObservation(state, stimulus)
        }
    })

    const gait = await phase("plan", async () => nextGaitCommand(state))

    await phase("actuate", async () => {
        await kernel.run(`await robot.setJoints(${JSON.stringify(gait)})`)
    })

    stop()
})
```

The cognet doesn't know it's driving a robot. It folds stimuli, computes, and asks the
kernel to run code. Whether that code moves a servo, posts to an API, or writes a file is
the kernel's business and the agent's policy — not the mind's.

## Virtual organisms

The same properties that suit a robot suit a simulation, and the simulation is easier to
run a thousand times.

A cognet in a simulated world is a complete experimental subject: its entire decision
history is in the log, replayable, with a flame graph of every tick. You can kill it
mid-decision and watch it reconstitute. You can run the identical cognet against a
different world by swapping the stimulus source, with no change to the brain.

For studying cognition rather than shipping a product, that reproducibility is the whole
game — and it comes from the same constraints that make the engine portable in the first
place.

## What's ready today

Honesty about the boundary:

| Capability | Status |
|---|---|
| Invocation-mode cognets | shipping — this is what every agent runs |
| Arbitrary loop structure, phases, systems | shipping |
| Multiple engines per tick, no engine at all | shipping |
| Log-shaped memory, `kill -9` durability | shipping |
| Full tick/phase/system telemetry | shipping |
| Continuous mode | shipping — the brain drives it with `kernel.wake()` |
| Entity/component authoring API | live in the engine, not yet exposed to cognet source |

Continuous mode was the gap that mattered for most of this page, and the shape it landed
in is worth stating plainly: the cognet declares `mode: { kind: "continuous" }` and
nothing else, while the **rate lives in the brain's own plugin**, driving `kernel.wake()`
at whatever pace that mind needs to think. A rate in the cognet config would have been the
brain asserting how fast its world turns; a rate in the body would have been the body
asserting how often a mind should think. They are different quantities, and only the
second belongs to cognition.

Wake-overlap policy: **every tick wakes**, however long the last one is still taking.
Wakes run concurrently and share the cognet's module scope, which is what lets a mind
sense and think at once — the fast path folds stimuli every tick while slow deliberation
runs across many of them. A skipped tick would not be a late tick but a deaf one, since a
stimulus is delivered once and then dropped.

Coordinating the overlap belongs to the cognet, through its own resident state. The
kernel offers no primitive for it.
