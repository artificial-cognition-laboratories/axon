---
title: Trace & Events
---

# Trace & Events

Two views over the same run. Events is what happened. Trace is that laid against time.

## Trace

::TerminalImage{src="/fleet/trace-pane.png" alt="The Trace pane showing a flame graph of one run's engine, tool and capsule spans"}
::

A flame graph of the run's spans — engine calls, tool calls, capsule commands — nested by
what spawned what, sized by how long they took.

It answers the question no log answers quickly: **where did the time go?**

::TerminalVideo{src="/fleet/trace-zoom.mp4"}
::

The shape of a run is legible at a glance.

::TerminalImage{src="/fleet/trace-shapes.png" alt="Three flame graphs: a healthy loop of short calls, one enormous engine call, and a staircase of repeating spans"}
::

A tight sequence of short calls is a healthy loop. One enormous bar with nothing under it
is an agent thinking with no tools. A staircase of near-identical spans is a loop that is
not converging.

## Events

::TerminalImage{src="/fleet/events-pane.png" alt="The Events pane showing the ordered runtime stream classified by namespace"}
::

The full stream, in order, classified by namespace:

| | |
|---|---|
| `build:` | Resolving and preparing the agent |
| `kernel:` | The runtime's meter around engine calls, tools, the loop |
| `cognet:` | The brain narrating itself |
| `capsule:` | The sandbox — commands, processes, policy |
| entries | The conversation: stimuli in, output and actions out |

::TerminalVideo{src="/fleet/events-live.mp4"}
::

The three worth knowing by name:

`axon:agent:message` — what it actually said.
`capsule:stdin` / `capsule:stdout` — what it ran, and what came back.

::TerminalImage{src="/fleet/events-capsule.png" alt="A capsule command and its output in the event stream"}
::

`capsule:denied` — what [policy](/docs/v2/agent/policy) stopped.

::TerminalImage{src="/fleet/events-denied.png" alt="A denied capsule action in the event stream"}
::

That last one saves the most time. An agent that "ignored" an instruction to edit a file
very often tried and was refused — which looks like a reasoning failure in the transcript
and a one-line config fix here.

Entry types are documented under [Entries](/docs/v2/api/thread/index).

## Working them together

::TerminalImage{src="/fleet/debug-flow.png" alt="Trace to Events to Engine — find the span, read what happened, see what the model was given"}
::

1. **Trace** — find the span where it went wrong.
2. **Events** — read what happened around it.
3. **Engine** — open that call and read what the model was given.

Most investigations end at step two. The ones that do not are context problems, and step
three is where those become visible.

---

Back to [Debugging in Code](/docs/v2/fleet/debugging), or on to
[Managing Agents](/docs/v2/fleet/management).
