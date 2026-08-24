---
title: Anatomy
---

# Anatomy

Five regions, top to bottom. Only two are always on screen — the header and the input
bar. The rest appear when they have something to say.

::TerminalImage{src="/tui/anatomy-full.webp" alt="The full Axon TUI screen with the header, conversation, status row, and input bar labelled"}
::

## Header

The identity block. Who you are talking to, what is powering it, and where this
conversation is recorded.

::TerminalImage{src="/tui/anatomy-header.webp" alt="Close-up of the TUI header showing the braille logo, agent name, session id, account email, tool count and model"}
::

| Line | What it tells you |
|---|---|
| Agent name | The focused instance — the thing your next message reaches |
| Session id | This conversation's record. Press it to open the `.jsonl` |
| Account | The signed-in profile |
| Loaded | Modules and tools the agent actually registered, and boot time |
| Model | The engine the focused agent declares — what `*` changes |

The tool count is the live manifest, not what the config asked for. If something you
wrote is missing here, it did not register and the agent cannot call it.

## Conversation

The message stream for the focused instance: what you sent, what the agent said, every
tool call it made, and any errors along the way. One instance is one continuous stream —
there are no branches to track.

::TerminalImage{src="/tui/anatomy-conversation.webp" alt="TUI conversation area showing a user message, agent response, and an expanded tool call with its output"}
::

Tool calls render inline as they run. Nothing is hidden behind a toggle you have to know
about — the point of the interface is that you can see what the agent did.

## Status row

Appears only while something is happening. It carries the spinner and a label for the
current activity — booting, working, rebooting, shutting down — and the update notice
when a newer Axon is available.

::TerminalImage{src="/tui/anatomy-status.webp" alt="TUI status row showing a spinner with a working label, and an update available notice on the right"}
::

When nothing is in flight the row is empty, so the interface is quiet by default.

## Input bar

Where you type, and the most information-dense part of the screen. The symbol on the left
is the active mode.

::TerminalImage{src="/tui/anatomy-input.webp" alt="TUI input bar showing the mode symbol, the typed message, and the working directory on the row beneath"}
::

The row beneath the box normally shows your working directory — but it is shared, and
several things borrow it:

| What shows | When |
|---|---|
| The path | Default |
| A notice | `tui.info` / `warn` / `error`, tinted, for a few hundred ms |
| An escape hint | A palette is open and `Escape` will back out |
| The exit ladder | `ctrl+c` was pressed and outranks everything else |

One line, one thing at a time, and the terminal's own hints always win. A notice fired
during the exit window waits rather than displacing it.

## Palette

Opens over the input bar when you press a mode key. Type to filter, arrows to move,
`Enter` to confirm, `Escape` to cancel.

::TerminalImage{src="/tui/anatomy-palette.webp" alt="TUI command palette open above the input bar, showing a breadcrumb, filtered rows with descriptions, and the cursor on a row"}
::

Every palette is the same widget — the built-in ones and any you register have identical
row shapes, filtering and navigation. That is deliberate: a palette you write is as good
as `:`, and gets better when `:` does.

Some rows are a **descent** rather than an action. Selecting a group rewrites the query
instead of running something, and the breadcrumb shows how deep you are. A working row
replaces the list while an async action runs, and the list returns when it settles.

## Where to go next

**[Models](/docs/v2/tui/models)** — what `*` opens, and how to find a model in it.

**[Profile Structure](/docs/v2/tui/structure)** — where your config lives, and what
each file is for.
