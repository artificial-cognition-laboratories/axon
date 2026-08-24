---
title: Managing Agents
---

# Managing Agents

Running one agent is a command. Running many is a fleet — and a fleet needs somewhere to
watch it from.

There are three entry points, and they are views onto the same running machine.

## The CLI

Start an agent, run a prompt, check what's alive.

::TerminalImage{src="/fleet/cli-ps.png" alt="axon ps listing every running agent on the machine with its pid and session"}
::

## The TUI

Talk to an agent. Switch between them. One terminal, whichever agent you want.

::TerminalImage{src="/fleet/tui-agent-switch.png" alt="The TUI agent switcher showing local, repo, and deployed agents across tabs"}
::

## The extension

**Axon Fleet** puts the whole machine in the editor: every agent, every running process,
every past run, and the console to inspect any of them.

::TerminalImage{src="/fleet/sidebar-overview.png" alt="The Axon Fleet sidebar showing the Assets register above the Workspace job board"}
::

## They share one runtime

Every booted agent registers itself locally. All three read that same registry, so none
of them owns a fleet — they observe one.

::TerminalImage{src="/fleet/three-surfaces.png" alt="An agent started in a terminal appearing in the TUI and the extension sidebar at the same time"}
::

Start an agent from a terminal and it appears in the sidebar. Click it in the sidebar and
you can take over the conversation in the TUI, in the session it was already in.

::TerminalVideo{src="/fleet/open-in-tui.mp4"}
::

That is the integration: you are never restarting an agent to look at it from somewhere
else. You are joining a run in progress.

## Two views

The extension organises the machine into two.

::TerminalImage{src="/fleet/two-views.png" alt="Assets listing agents and prompts beside Workspace listing jobs grouped by repo"}
::

**[Assets](/docs/v2/fleet/management/assets)** — what can do work.
**[Jobs](/docs/v2/fleet/management/jobs)** — what needs doing.

The whole interface exists to make the edge between them cheap: take something from the
register, point it at something on the board.

## The human assigns

Agent capacity is effectively free, so scheduling agents efficiently buys nothing. The
scarce resources are your review bandwidth and your codebase's integrity — so a person
decides what runs against what.

Fleet reads your machine, not your account. Agents come from disk, processes from the
local registry, jobs from your repos. Nothing is uploaded.

---

Next: [Running Instances](/docs/v2/fleet/management/instances) — everything alive, and
what you can do to it.
