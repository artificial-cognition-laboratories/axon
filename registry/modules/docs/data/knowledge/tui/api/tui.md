---
title: tui
---

# tui

The terminal itself. Deliberately thin — a verb with a natural home in `commands`,
`keys`, `palette`, `mode`, `input` or `agents` lives there instead.

```ts
interface TuiApi {
    // Go to an agent: focus the instance you were last on, booting one if
    // none is live. The ~ key's behaviour, addressed by NAME.
    nav(name: string): Promise<void>

    // Register a lifecycle handler. See Hooks below.
    hook<N extends TuiHookName>(name: N, handler: TuiHooks[N]): Disposer

    // A brief label on the cwd row. ms defaults to 300, clamped to a few seconds.
    info(message: string, ms?: number): void
    warn(message: string, ms?: number): void
    error(message: string, ms?: number): void

    readonly size: { width: number; height: number }   // in cells, not pixels
    readonly cwd: string       // where axon was LAUNCHED from, not process.cwd()
    readonly version: string

    // Quit, running the same tui:shutdown gate a ctrl+c does.
    exit(): Promise<void>
}
```

There is deliberately no `update()`: a self-update hands off to a helper that runs after
the process exits, and an extension triggering that is a way for a config to brick an
install mid-session.

## nav vs focus vs spawn

```ts
await tui.nav("zeno")        // this AGENT — last instance, or boot one
agents.focus(id)             // this exact INSTANCE
await agents.spawn("zeno")   // always a NEW instance, in the background
```

Three real verbs. "Take me to this agent" and "focus this exact process" are different
questions, and only one has an answer when nothing is running yet.

## Notices are a reaction, not a message

```ts
tui.info("deployed")
tui.warn("nothing to do", 600)
tui.error("command failed")
```

This row's other tenants are the `ctrl+c` and double-esc hints, and these are the same
kind of thing: something to catch the eye, not something to read. Past ~50 characters it
is trailed with an ellipsis, and a notice fired during the exit window waits rather than
displacing the ladder.

Anything with **content** — a reason, a path, a stack — belongs in a throw, which lands
in the config error list on the chat page:

```ts
commands.register("deploy", async () => {
    const res = await deploy()
    if (!res.ok) throw new Error(`deploy failed: ${res.stderr}`)
    tui.info("deployed")
})
```

## cwd is not process.cwd()

```ts
const text = await Bun.file(`${tui.cwd}/README.md`).text()
```

VTerm changes the process working directory to the application package while booting, so
`process.cwd()` names our install rather than your project.

## Hooks

`tui.hook(name, handler)` returns a `Disposer`. Available in `main.ts`, any
`plugins/*.ts`, and any extension — `plugins/` is convention, not capability.

```ts
type TuiGateHooks = {
    "tui:boot": (payload: {}) => void | Promise<void>
    "tui:shutdown": (payload: {}) => void | Promise<void>
}

type TuiNotifyHooks = {
    "tui:reloaded": (payload: {}) => void
    "tui:resize": (payload: { width: number; height: number }) => void
    "key:pressed": (payload: { key: string; mode: ModeName }) => void
    "palette:opened": (payload: { name: ModeName }) => void
    "palette:closed": (payload: { name: ModeName }) => void
    "command:ran": (payload: { path: string; source: "palette" | "api" }) => void
    "command:failed": (payload: { path: string; source: "palette" | "api"; error: unknown }) => void
    "agent:ready": (payload: { instance: AgentInstance }) => void
    "agent:stopped": (payload: { instance: AgentInstance }) => void
    "agent:focused": (payload: { instance: AgentInstance }) => void
    "message:sent": (payload: { content: string; instance: AgentInstance }) => void
    "message:received": (payload: { instance: AgentInstance }) => void
    "mode:changed": (payload: { from: ModeName; to: ModeName }) => void
}
```

**Every hook takes one object**, including the ones with nothing to say — so a handler
reads the same way everywhere, and a hook gaining a field never breaks one you wrote.

```ts
tui.hook("tui:resize", ({ width, height }) => { ... })
tui.hook("tui:boot", () => { ... })            // nothing to take — still fine
```

**Gate or notify** is a property of the event, not of how you registered — which is why
there is one `hook()` verb rather than a blocking and a non-blocking one:

```ts
tui.hook("tui:shutdown", async () => { await flush() })          // waits
tui.hook("agent:ready", ({ instance }) => { void warm(instance) }) // does not
```

Gates are bounded: one that takes too long is reported and the operation continues. A
throwing handler is reported and its siblings still run.

Four semantics worth knowing before you reach for them:

- **`key:pressed` observes, it never intercepts.** It fires only for keys nothing handled,
  with no way to consume the press — user keys dispatch from a wildcard running *before*
  built-in bindings, so a consumable hook could swallow `ctrl+c`. `key` round-trips into
  `keys.register`.
- **`message:received` carries no content.** Reacting to *what* was said is writing an
  agent, which is a [cognet's](/docs/v2/cognets) job. This says only *that* a wake
  completed.
- **`command:ran` carries `source`.** `"api"` means an extension ran it — without checking
  that, a handler reacting to commands by running one recurses into itself.
- **`palette:opened` is narrower than `mode:changed`.** The latter fires for every
  transition including `loading` and `voice`; the former only when there are rows to pick
  from.

```ts
// plugins/resume.ts — reopen the last agent on launch
const FILE = `${process.env.HOME}/.axon-last`

tui.hook("tui:shutdown", async () => {
    const focused = agents.focused()
    if (focused) await Bun.write(FILE, focused.name)
})

tui.hook("tui:boot", async () => {
    const last = await Bun.file(FILE).text().catch(() => "")
    if (last) await tui.nav(last.trim())
})
```

Both gate, which is why it works: the write finishes before the process goes, and the
agent is on screen before you can type into it.
