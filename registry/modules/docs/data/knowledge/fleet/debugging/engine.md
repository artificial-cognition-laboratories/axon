---
title: The Engine Pane
---

# The Engine Pane

When an agent does something unexpected, the answer is usually not in what it said. It is
in what it was given. The agent did the right thing with the wrong information.

This is that information — the exact document the model received.

::TerminalImage{src="/fleet/engine-pane.png" alt="The Engine pane showing one call's rendered AIR document with the model's response below it"}
::

## One page per call

Every engine call emits three events: the model it opened with, the messages it
committed, and the response that came back. The pane correlates them into one page.

::TerminalImage{src="/fleet/engine-pager.png" alt="The pager toolbar showing call time, provider and model, and position in the run"}
::

The pager steps through the run's calls.

::TerminalVideo{src="/fleet/engine-paging.mp4"}
::

Nothing is reconstructed. These are the messages the runtime committed, in render order —
not a replay assembled from thread entries. A call still in flight shows its input with no
output yet, rather than a guess at one.

## Reading the document

Context is rendered as [AIR](/docs/v2/concepts/air-format), which is tag-structured. The
pane slices it by section.

::TerminalImage{src="/fleet/engine-sections.png" alt="The section subtabs: all, meta, scope, system, contract, timeline"}
::

| | |
|---|---|
| **meta** | Who the agent is, where it is, what time it is |
| **scope** | The tools available on this call |
| **system** | Its identity and instructions |
| **contract** | The output shape it must produce |
| **timeline** | Everything that has happened so far |

Most context bugs are visible immediately. A tool the agent never called was never in
`scope`. An instruction it ignored was never in `system`.

::TerminalImage{src="/fleet/engine-scope.png" alt="The scope section showing exactly which tools were offered on this call"}
::

Switching sections keeps your place in the run, so you can hold one section open and page
through every call watching only that part change. Watching `timeline` grow is the fastest
way to find where context went bad.

::TerminalVideo{src="/fleet/engine-timeline.mp4"}
::

## The response, unparsed

Below the document: what came back before the runtime parsed it.

::TerminalImage{src="/fleet/engine-output.png" alt="The output half showing text, thinking, stop reason and attempt count"}
::

`stopReason: length` means the model was cut off mid-thought and everything downstream is
working from a truncated answer. Attempts above one means the call failed and was retried
— invisible in the final output, and often why a run took far longer than it should have.

## Why this pane matters

The rest of the Console tells you what happened. This tells you what the agent knew when
it decided.

Prompts, tools, modules, memory, policy — every part of building an agent resolves to one
question: *did the model see what I think it saw?* This is the only view that answers it.

---

Next: [Trace & Events](/docs/v2/fleet/debugging/trace) — where the time went.
