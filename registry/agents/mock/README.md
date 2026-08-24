# @axon/mock

A deterministic agent. No model, no key, no spend — every reply is written into the
agent and addressed by a slash word.

Reach for it when you are building the thing *around* an agent — a TUI extension, a
fleet script, an HTTP client, a CI job — and you need the other end of the wire to do
something specific, immediately, the same way every time.

```bash
axon install @axon/mock
axon dev --agent mock
```

Then type `/help`.

## Commands

| Command | What it does |
| --- | --- |
| `/hello` | Reply with a short greeting. The smoke test. |
| `/markdown` | Speak a document using every common markdown construct. |
| `/code` | Speak fenced code blocks in several languages. |
| `/long [paragraphs]` | Speak a long reply. Exercises scrollback and wrapping. |
| `/wide` | Speak content wider than the pane. Exercises horizontal overflow. |
| `/unicode` | Speak emoji, CJK, RTL, combining marks and box drawing. |
| `/log` | Run a `console.log` in the capsule, then report what it printed. |
| `/tool` | Call a real tool, see the result, then speak about it. |
| `/loop [ticks]` | Take a given number of visible loop ticks before finishing. |
| `/think [ticks]` | Take several reasoning-shaped ticks without acting. |
| `/fail` | Throw inside the capsule. Exercises the error path. |
| `/slow [lines]` | Deliver a reply gradually, one line per tick. |
| `/burst` | Speak one short line with nothing to stream. |
| `/help` | List every command. |

Anything without a leading slash is echoed back, the way bare `Mock()` behaves. A slash
word that matches no command shows the list, because it is a typo rather than prose.

## Everything except the model is real

The agent boots a real kernel, a real capsule and your real policy. `/log` and `/tool`
genuinely execute — the result enters the session log and the next tick reads it back,
which is the same path a real model's tool call takes. That is what makes `/loop` worth
watching rather than merely reading: it is an actual agent loop, just one whose decisions
were written in advance.

## Adding a command

Commands live in `src/mock/commands.ts`. A command is a function of the tick and the
argument:

```ts
const twice: Command = {
    summary: "Speak on two ticks.",
    turn: ({ tick }) => tick === 0
        ? { step: "first", continue: true }
        : "second",
}
```

Add it to the `commands` map and `/help` picks it up — the table renders itself from that
map, so there is no second place to edit. Return a bare step to end the turn, or
`{ step, continue: true }` to wake again. `run(code)` executes in the capsule instead of
speaking.
