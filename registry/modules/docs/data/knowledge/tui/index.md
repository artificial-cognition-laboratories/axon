---
title: Terminal
---

# The Axon terminal

A terminal client built for running agents. Every tool call is visible, every
conversation is navigable, and every model is a few keystrokes away.

::TerminalImage{src="/tui/axontuiemptychatwindowcleanlanding.webp" alt="Axon TUI landing screen showing the Axon braille logo, the connected agent name, its model, and the registered tool count"}
::

You never install an agent to get started. On first launch the TUI ensures **Zeno**
exists — a real agent project in your profile, cloned from the registry — because an
agent is the only thing that can run, and a new user has none. Delete it and it comes
back.

## Everything is a mode

You are always in one. The default is `normal`: type a message, press Enter, it goes to
the focused agent. Press a mode key on an **empty** input to switch; press it again, or
`Escape`, to come back.

| Key | Mode | What it opens |
|---|---|---|
| `:` | command | The `:` command tree |
| `~` | agent | Start an agent |
| `/` | instance | Switch to a running conversation |
| `^` | session | Reopen a past conversation |
| `*` | model | Set the focused agent's model |
| `%` | module | The agent's modules, and the registry |
| `>` | prompt | Insert a prompt into your message |
| `"` | theme | Switch colour theme, with live preview |
| `#` | voice | Voice input |
| `?` | help | Keyboard reference |
| `↑` | history | Previous messages (on an empty input) |

The active mode shows as a symbol at the input bar, so the thing telling you what a
keystroke will do is always the thing you are typing into.

Two of these also work **mid-sentence**, because they have a coherent answer for what
happens to text already in the box: `#` appends its transcript, and `@` splices a file
path over its own trigger. The rest stay literal characters once you have started typing.

::TerminalImage{src="/tui/axonhelppaletteopen.webp" alt="TUI keyboard reference palette listing every mode key and binding by category"}
::

A few keys are the terminal's and cannot be rebound: `ctrl+c`, `ctrl+d`, `Escape`,
`Enter`, `Tab`, the arrows, and backspace.

## Agents, instances, sessions

Three keys look similar and are not. They address three different nouns, separated by
tense:

| Key | Noun | Tense | What it is |
|---|---|---|---|
| `~` | **agent** | timeless | The project — config, tools, prompts |
| `/` | **instance** | present | A live process you can talk to |
| `^` | **session** | past | A recorded conversation on disk |

One agent can have many instances running at once. One instance writes one session.

- **`~` always spawns.** Selecting an agent starts a *new* instance and focuses it. It
  never navigates you back to something already running.
- **`/` is how you go back.** Live conversations only, in spawn order — a list you
  navigate must not reorder under the cursor.
- **`^` reopens the past.** The focused agent's sessions, newest last. If that session is
  still live it focuses it; otherwise it boots an instance over the log.

The rule that makes all of this safe to explore: **nothing reachable from a palette
destroys a conversation.** `:agent close` is the only verb that ends one. Without that,
every key needs its own memorised answer to "does this replace what I'm on?"

## Commands

`:` opens a filterable tree. Type to narrow, `Space` to descend into a group, `Tab` to
complete, `Enter` to run. The breadcrumb shows where you are.

::TerminalImage{src="/tui/axontuicommandpaletteopennothingtyped.webp" alt="TUI command palette open at the top level with no filter typed"}
::

| Group | Commands |
|---|---|
| `:agent` | `spawn` `switch` `close` `reboot` `clear` `model` |
| `:session` | `pick` `fork` `rename` `open` |
| `:module` | `install` `update` `uninstall` |
| `:ext` | `install` `update` `uninstall` |
| `:provider` | `codex connect\|disconnect` · `openrouter connect\|disconnect` |
| `:open` | `log` `flame` `engine` |
| top level | `:init` `:reload` `:update` `:docs` `:logout` `:exit` |

`:open` needs an attached editor — it opens this session's event log, its trace as a
flame graph, or its engine calls as a buffer. See [Fleet](/docs/v2/fleet).

Enter runs what you **typed**, never what happens to be highlighted. Command mode's query
is a path, not a filter, so a partial like `: up` refuses rather than firing `update`.

## What's next

**[Anatomy](/docs/v2/tui/anatomy)** — the screen, region by region.

**[Models](/docs/v2/tui/models)** — one searchable list of every way to run a model.

**[Profile Structure](/docs/v2/tui/structure)** — where your config lives on disk.

**[API](/docs/v2/tui/api/tui)** — the formal reference for the eight globals.
