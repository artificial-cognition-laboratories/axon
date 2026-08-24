# @axon/mock

## What This Is

A deterministic agent published to the registry. It has no model: every reply is written
into `src/mock/commands.ts` and selected by a leading slash word.

Its users are people building the thing *around* an agent — TUI extensions, fleet
scripts, HTTP clients, CI jobs — who need the other end of the wire to behave a specific
way, immediately, repeatably, for free.

## The Design

**Commands are programs, not strings.** A `Command` is a function of `(tick, arg)`, which
is why this is a `Mock()` handler rather than a reply map. The map form matches a
substring and returns a canned value; it cannot express `/loop 5` (an argument) or `/log`
(act on tick 0, read the result on tick 1). Those two are the point of the agent.

**One tick, one turn.** `turn()` returns a bare step to end the turn, or
`{ step, continue: true }` to withhold `<done/>` and wake again. Multi-tick commands
re-derive their position from `ctx.tick` every call, because engine drivers are stateless
request→response and nothing may be remembered between them.

**Help renders from the command map.** Adding a command to `commands` is the only edit —
`renderHelp()` walks that map. A second hand-maintained list would drift on the first
addition.

**Prose echoes; a bad slash word does not.** Plain text is echoed, matching bare `Mock()`.
A slash word matching no command shows the list, because the user already signalled they
wanted a command.

**What it is NOT:** a mock-data generator, and not a place for behaviour that needs a
model. Anything requiring judgement belongs in an agent with a real engine.

## Key Interfaces

- `MockCommands()` — `src/mock/engine.ts`. The engine handed to `defineAgent`.
- `commands` — `src/mock/commands.ts`. The set, keyed by the word you type.
- `Command` — `{ summary, usage?, turn(ctx) }`. One simulated behaviour.
- Sample prose lives in `src/mock/samples.ts`, apart from the behaviour list.

Depends on `@arcforge/engines/mock` for `Mock`, `run`, `extractUserText`, and the
`MockContext` / `MockTurn` types.

## Known Debt

`tests/commands.test.ts` drives the engine driver directly rather than booting the runtime
through `Axon()`, because the documented `Axon()` test global is declared but never
installed — see `libs/axon/platform/debt.md`. When that is fixed these become real runtime
tests and should assert on `result.entries` (proving `/log` actually executed) rather than
on the emitted `<script>` block.

The agent resolves `@arcforge/engines` from the Axon cache tree, which holds the
*published* package. Testing a workspace change to the mock engine requires linking that
entry to `libs/axon/packages/engines` first; the multi-tick command set needs a version
newer than the pinned `2.0.146`.
