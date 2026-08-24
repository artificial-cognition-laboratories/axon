---
title: The Console
---

# The Console

A session is a `.jsonl` file — every request, every engine call, every command, every
policy decision, in one order. Everything you need is already on disk. Reading it by hand
is the problem.

The Axon Console is that file, rendered.

::TerminalImage{src="/fleet/console-overview.png" alt="The Axon Console panel showing the Logs, Events, Trace and Engine tabs over one run"}
::

## Four panes

**Logs** — what it said while running.

::TerminalImage{src="/fleet/pane-logs.png" alt="The Logs pane showing the agent's output as it runs"}
::

**Events** — what happened, in order.

::TerminalImage{src="/fleet/pane-events.png" alt="The Events pane showing the classified runtime stream"}
::

**Trace** — where the time went.

::TerminalImage{src="/fleet/pane-trace.png" alt="The Trace pane showing a flame graph of the run's spans"}
::

**Engine** — what the model actually saw.

::TerminalImage{src="/fleet/pane-engine.png" alt="The Engine pane showing the rendered document sent to the model"}
::

[Trace & Events](/docs/v2/fleet/debugging/trace) find where a run went wrong.
[Engine](/docs/v2/fleet/debugging/engine) finds why.

## Live and finished are the same interface

Every pane reads from a **source**: a running instance, or a session file on disk.

::TerminalImage{src="/fleet/live-vs-session.png" alt="The instances group above the sessions group, both feeding the same console panes"}
::

Watch a run happen:

::TerminalVideo{src="/fleet/console-live.mp4"}
::

Or open one that finished last week and read it through the identical panes:

::TerminalVideo{src="/fleet/console-replay.mp4"}
::

A finished session is not a lesser view. It is the same file the live view was tailing,
which stopped appending. A run you missed is as debuggable as one you are watching.

## Three things to point it at

::TerminalImage{src="/fleet/console-subjects.png" alt="An instance, a session, and an agent as the three console subjects"}
::

An **instance** tails live. A **session** replays. An **agent** is the stable subject —
its Sessions tab lists every past run, so you pick one and inspect it without re-targeting
the console.

::TerminalVideo{src="/fleet/agent-sessions.mp4"}
::

## It works for any agent

The panes read `kernel:*` telemetry — the runtime's own meter around every engine call,
tool, and command. Nothing from inside a cognet.

So a custom cognet gets the same Trace and the same Engine view as a stock one, and never
needs to know a debugger exists.

---

Next: [The Engine Pane](/docs/v2/fleet/debugging/engine) — the one view you cannot get any
other way.
