---
title: Running Instances
---

# Running Instances

Every booted agent registers itself while it runs. One list, every live agent on the
machine, whoever started it.

::TerminalImage{src="/fleet/instances.png" alt="The instances group listing live agents with agent name, pid and session id"}
::

Not scoped to the folder you have open. An agent started from a terminal in another repo,
one launched by the TUI, one running on a schedule — all of them appear. A process list
that can hide a process is not a process list.

Subagents nest under the instance that spawned them.

::TerminalImage{src="/fleet/subagents.png" alt="An instance row expanded to show the subagents it spawned nested beneath it"}
::

Records are pid-checked on every read, so a crashed agent leaves the list on its own.

## Starting one

**Start Dev Server** on any agent runs it the same way `axon dev` does. It joins the
instances list a moment later.

::TerminalVideo{src="/fleet/start-dev.mp4"}
::

## Inspecting one

Point the [Console](/docs/v2/fleet/debugging/console) at it and read it live.

::TerminalVideo{src="/fleet/inspect-instance.mp4"}
::

## Taking over

**Open in TUI** focuses that session in a running TUI — the same session, mid-run.

::TerminalVideo{src="/fleet/open-in-tui-instance.mp4"}
::

You are joining the conversation the agent is already having, not starting a new one.

## Stopping

::TerminalImage{src="/fleet/instance-stop.png" alt="The stop action on a running instance row"}
::

Stopping signals the process group rather than the process, because `axon` launches the
runtime as a child — signalling the launcher alone would leave the runtime alive. The
record disappears when the pid does.

---

Next: [Assets](/docs/v2/fleet/management/assets) — what you can dispatch.
