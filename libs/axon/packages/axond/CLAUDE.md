# @arcforge/axond

## What This Is

The Axon daemon — one process per user, per machine, owning everything no
single agent can own.

Not an inference server. Inference is its first tenant, not its purpose. The
job is *"I am the one process on this box that holds shared state"*, and five
things need that:

- **machine** — the GPU. Two agents deciding independently that 6GB is free is
  how both take it.
- **agents** — every agent running here. A registry a terminal cannot outlive.
- **models** — one resident copy of a weight, however many agents hold it.
- **dictation** — the microphone, and the words it becomes. The clearest case
  of all: a recording spans two keypresses that the compositor launches as two
  separate processes, so something resident has to hold the mic in between.
- **jobs** — work delegated to an agent, and the record of what happened. The
  layer ABOVE agents: an agent run is one attempt, a job is the thing you asked
  for, and the difference shows up on the second attempt. `AgentRecord.job`
  was already the correlation link; this is the other end of it.

**Dictation is the thesis, demonstrated.** Press a key, speak, and the words
are typed where the cursor already is — no window, no indicator, no chat box.
It needs the mic held across two processes, the speech model already resident
(a cold load costs the first word), and it must work with no terminal and no
editor open. Nothing but a daemon can do that, which is why it belongs in the
same product as a model manager: local models as an OS capability, not an app.

**Auto-use, never auto-install.** `Runtimes` reports which speech runtime this
machine can use and what faster one it is missing; nothing acquires anything on
its own. Installing goes through `omarchy-install-app`, which opens a visible
terminal and prompts for the password there — so this process never handles a
credential or invokes `sudo`, which is the line that keeps a desktop plugin
trustworthy on a store.

The bundled ONNX path stays the FLOOR: it needs no permissions and cannot be
missing, so dictation works out of the box and keeps working if a package is
absent or broken on someone's distro. Everything else is an accelerator.

**No GPU package is ever offered.** Arch's `whisper-cpp` is CPU-only — it
depends on `ggml`, whose own dependencies are `glibc libgcc libstdc++ libgomp`
and nothing else. The GPU builds live in the AUR at zero votes and zero
popularity and pull a full CUDA runtime; pointing a large userbase at an
unvetted one-person build is worse than publishing our own, because it vouches
for a stranger's binary. A GPU build is USED when already installed and never
suggested. The device is read from what the binary is LINKED against rather
than from its package name, because a build called `whisper-cpp` may be either.

**Anything the DESKTOP launches gets an environment your shell does not have,
and `desktopCommand()` is the one answer to it.** This trap has been hit four
separate ways: the boot unit's `ExecStart` naming a bare `axon` (systemd does
not search the user's PATH), the same unit with an absolute path failing on
`env: 'bun'` (the shebang's interpreter is not on a service's PATH either, 671
restarts), a dictation keybind naming a bare `axon` (a Hyprland exec has no
`~/.cache/.bun/bin`, and a keypress did exactly what a typo does), and that
keybind with an absolute path hitting the shebang again. Every check of these
passes, because every check runs in the shell that has the right PATH. One
function now builds the whole line — PATH exported, binary resolved, operands
appended — and it resolves `axonl` under a source build so the two stores
cannot silently reach each other.

The chord is registered LIVE via `hyprctl eval`, never by editing anyone's
config. A plugin that rewrites a hand-maintained `bindings.lua` owns a merge
problem forever and leaves a dead keybind behind at uninstall. The cost is that
a binding does not survive a compositor reload, which is why `serve()`
re-applies it at every start — and why `dictation.bound` records what was last
bound, so changing the chord clears the old one instead of leaking it.

`schedule` is the sixth and is deliberately unwired: boot-time agents and
cron-style wakeups are the reason this is a daemon rather than a library, and
naming the domain now is what stops it arriving as a concern bolted to the side.
It is also the closest thing to `jobs` — a schedule is a job with a trigger, and
whichever lands second should absorb the other rather than duplicate it.

## The Design

**Two roots, one shape.** `Axond()` is the server-side composition root;
`AxonDaemon()` is the client handle. They expose the SAME domains, which
is what lets the daemon be tested in-process without a socket — construct
`Axond()` and exercise it — while the transport is tested once, separately.

**Degraded, never blocked.** The daemon being down must not stop local agents
working. Every verb that needs it fails loudly naming the fix; the file-based
reservation protocol in `~/.axon/cache/resources` stays as the honest degraded
path, because every reader already reaps dead pids and works with no daemon at
all.

**The client handle IS the SDK.** `daemon.agents.at(id)` returns an instance
handle you can talk to, not a record you look things up in. That distinction
is why a future SDK is this surface with documentation rather than a
translation layer over an RPC shape.

**A job's state is never stored, only folded.** `queued/running/blocked/...` is
a fold over an append-only event log, not a column. Locally that costs nothing —
there is one writer. It is a deliberate bet on the shared case: two machines
appending is an ordering question with an answer, two machines SETTING a status
field is data loss. The same log is what the panel renders and what `attach`
will subscribe to.

**Two axes, never one status.** `run` is the agent's lifecycle; `acknowledged`
is the person's. Collapsed into one field, either the agent clears your list or
you cannot. The verbs split the same way: an agent may report `finished`, only
a person may `acknowledge`, `cancel` or `retry`.

**The human mark is confinement, not cryptography.** An actor is an agent when
`AXON_SESSION_ID` is set (the link sets it on every confined incarnation), and a
person when the signed-in account can be read from the store. That is honest for
a confined agent, which has no credential and cannot read the store. It is NOT
proof against a process already running unconfined as this user, and the code
says so rather than implying more.

**`control/` is transport, not a domain.** It is where the socket and the
lifecycle live. Putting it beside the four would make the surface lie about
what the daemon is.

## Key Interfaces

```typescript
const axond = Axond(opts)      // server: what bin/axond.ts boots
const daemon = AxonDaemon(opts) // client: what every consumer holds

daemon.machine.state()          // hardware, budget, what is held
daemon.agents.list()            // every agent on this machine
daemon.agents.at(id)            // one instance, as a handle
daemon.models.resident()        // what is loaded
```

## Known Debt

`models` and `schedule` are unwired and throw. See `debt.md`.

~~Whisper hallucinates on silence~~ — resolved by the duty-cycle gate in
`Segments`; see `debt.md`.

**Dictation latency, measured.** A keypress cost 650ms because it loaded a 25MB
CLI bundle to write one line to a socket — and the BUILT binary was no faster
than source, so every user paid it, twice per dictation. It now goes straight to
the daemon's HTTP-on-unix protocol with `curl`: 9ms. The level meter rode a 47KB
snapshot at 2Hz; dictation now has a fast lane on the same stream, ~700 bytes at
16Hz, emitted only while recording. And transcription no longer waits for the
end: `Segments` cuts on pauses so the work happens while you speak, leaving one
tail pass. Whisper still runs on the CPU — see `debt.md`.

**Streaming is phrase-by-phrase, and deliberately not word-by-word.**
LocalAgreement — re-transcribing the open buffer and committing the prefix two
passes agree on — was built here and removed. It works, and it cannot pay for
itself on an in-process runtime: each pass is CPU-bound work in the daemon's
own thread, so it froze the event loop for one to two seconds at a time. That
starved the 16Hz level stream and the listening indicator vanished mid-sentence
on a long dictation. The arithmetic was already against it (~900ms a pass
against a cadence wanting ~400ms); what only showed up in use is that the cost
of being over budget lands on the parts that were WORKING, not on the feature
that is late. It needs an out-of-process or much faster runtime, and has
neither.

**Text is typed phrase by phrase, while you are still speaking.** That is only
correct because `Segments` closes a segment after observing the pause that
FOLLOWS it, so a phrase is final by construction and is never revised — nothing
typed ever has to be unwritten. A sliding-window recogniser improves its guess
as more audio arrives, which is why incremental dictation usually means
backspacing over your own output; the pause-boundary design was chosen for
accuracy and this is the second thing it buys.

**`wtype` is paced, and spawned rather than spawnSync'd.** Its keystroke delay
defaults to ZERO, which reads as a corruption bug: a window doing work per
keystroke drops and reorders them, and "Hello. Can you hear me?" arrived as
"Yllo.Cnor?". Paced at 6ms it is still instant to a reader. Asynchronous
because the daemon is single-threaded and is serving the level meter at 16Hz
while it types — a synchronous spawn froze the visualiser at exactly the moment
someone was watching it.
