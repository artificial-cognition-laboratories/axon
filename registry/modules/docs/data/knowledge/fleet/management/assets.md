---
title: Assets
---

# Assets

The register of what can do work: **agents**, and the **prompts** they declare.

::TerminalImage{src="/fleet/assets.png" alt="The Assets view showing the agents group above the prompts group"}
::

## An agent is a folder

The row *is* the project directory. Expand it and you get the real source tree, with the
agent's past sessions folded in below.

::TerminalVideo{src="/fleet/assets-expand.mp4"}
::

It looks like the Explorer because it is rendered the way the Explorer renders — real
paths, your icon theme, no synthetic nodes pretending to be files.

That is what makes this the view to keep open while building. Source, past runs, and a
live process in one tree.

::TerminalImage{src="/fleet/agent-tree.png" alt="An agent folder expanded showing src, axon.config.ts, and its sessions folder"}
::

## Prompts are assets

A prompt under `src/prompts/` gets its own row, and runs from there.

::TerminalImage{src="/fleet/prompts.png" alt="The prompts group listing invokable prompts declared by agents"}
::

An agent is a worker; a prompt is a unit of work. Pairing one of each is the gesture the
interface exists for, so both are things you pick — not details of one another.

::TerminalVideo{src="/fleet/run-prompt.mp4"}
::

Components under `src/prompts/components/` are fragments composed into other prompts.
Never invokable, so never listed.

## The registry

Browse and install published agents without leaving the editor.

::TerminalVideo{src="/fleet/registry-install.mp4"}
::

Installs go through the `axon` binary, into the same local store the CLI uses — so an
agent installed here is identical to one installed from the command line, and appears in
Assets like any other. See [Publishing](/docs/v2/agents/publishing).

---

Next: [Jobs](/docs/v2/fleet/management/jobs) — what needs doing.
