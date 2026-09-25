# @arcforge/capsule — The Mediated Scope

## What This Is

The bounded place an agent's own code runs: model-emitted `<typescript>`, the
tools it calls, the processes it spawns. Everything that happens here is gated
by policy and lands on the event stream.

`Capsule()` is the single entry point. Its SHAPE is the contract —
`run`/`exec`/`interrupt`/`process`/`scope`/`on`/`boot`/`shutdown` — and that
shape survived the port unchanged, which is what let 32 of 34 test files stand
as the acceptance criteria rather than being rewritten alongside it.

## The Design

**A capsule used to BE a subprocess. It no longer is.**

The boundary sat between the kernel and the code it ran, so a second process
was how policy got enforced: model code could not reach the filesystem because
it was not in the same process as the thing that could. Once the whole agent
became a confined process — bwrap box, cgroup, its own mount namespace — that
inner boundary did nothing the outer one did not already do. The wall is the
agent's box; the capsule is the mediated scope inside it.

What that deleted: the JSONL wire and both its halves, the subprocess manager
and its crash supervision, the host bridge, the build/spawn pipeline, and the
host-side proc mirror. ~1,140 lines whose only job was crossing a boundary that
no longer exists.

What survived is everything that was never about the boundary:

```
inproc/      the manager and sandbox — composition only
process/     runner (TS eval), scope (tool loading + mediation wrapping),
             procs (process.run/spawn), mediator, console, activities
scope/       the process globals and the model-facing declarations
```

**The leaves ported untouched.** `Runner` transpiles and evals; `Scope` loads
tools and wraps every callable for mediation; `SandboxProcs` shells out. Each
took a `wire` and announced through it, and none cared what was behind it — so
`inproc/emitter.ts` is a shim onto the bus and the leaves did not change. That
is the test of whether a boundary was load-bearing: if removing it changes one
file, it was not.

## What Changed Behaviourally

Six things, each found by an existing test rather than by inspection:

- **Hard cancellation is gone.** Killing a process could stop a tight
  synchronous loop; nothing in one heap can. `interrupt` is COOPERATIVE —
  mediated calls observe the signal, which covers every await-shaped operation
  model code actually writes. A genuine `while (true)` runs until the
  supervisor restarts the agent: blast radius is one agent, one conversation.
  `tests/execution/interrupt.test.ts` states the new contract where it used to
  assert process replacement.
- **The eval must be RACED against its signal.** Subprocess-side the process
  died and the pending eval went with it. Here nothing ends it, so awaiting the
  eval alone meant an interrupted run resolved normally whenever the model sat
  in a plain `await`. The race settles the CALLER; the eval keeps running to
  whatever it was awaiting and its result is discarded.
- **cwd is process-global.** A sandbox that shut down parked in a deleted
  directory left the whole process with an unlinked cwd — every later
  `new Bun.Transpiler()` threw. Sandboxes restore the cwd they entered with.
- **`installScope` rebinds on reload.** The once-per-process guard existed
  because two sandboxes would fight over `process.run`; a reload legitimately
  replaces the owner, so it takes an explicit `rebind`.
- **`undefined` → `null`** was an accident of JSON having no undefined. The
  contract documented it, so it is deliberate now rather than lost.
- **Update tears down BEFORE rebuilding.** The subprocess brought the new
  incarnation up first ("overlap, not gap"); in one heap that would mean two
  mediators owning `process.run` at once.

## Policy: silence asks

**An explicit allow allows. An explicit deny denies. Silence asks.** One rule,
applied at every leaf of `decideShell` and to the surface as a whole.

This replaced a `fallback` parameter whose two callers passed opposite values —
the capsule "deny" (it runs foreign, model-emitted code and must never grant by
omission) and Axon "allow" ("I set no policy" meaning a personal tool with the
user's privileges). Both stances are now produced by escalation plus its
degradation, with no knob: a bare `Capsule()` has no decider, so `Escalation`
answers false immediately and it still runs nothing, while a user at a TUI is
asked and answering "always" writes the grant.

**The cost of the old shape was the first five minutes.** An agent with no
policy — which is every agent before anyone writes one — got
`shell.run:axon denied · no rule permits it`, a sentence with no next step in it
short of reading the docs.

**The subtle half was DELIVERY, not the decision.** `decideShell` returned
"escalate" correctly the whole time; `shell()` then handed it to `check()`,
which started over against the TOOLS map, found no rule for an address like
`shell.run:axon` (a program is not a tool and never has one), and denied by
omission. Every unit test over `decideShell` passed throughout. `escalate()` is
now factored out of `check()` so an already-made decision goes straight to the
ask, and `tests/policy/omission-asks.test.ts` exercises it through a real
capsule — which is the only level at which that class of bug is visible.

**A refusal says which kind it was.** `escalation-headless` (nobody to ask —
a script, CI, a deployment) is a different fact from `escalation-denied` (a
person said no), and only one of them has a fix. The response command carries
the distinction so the record can state it rather than implying a decision
nobody made.

## Where Confinement Went

`platform/src/confine/` — bwrap, cgroups, the policy→spec narrowing. It boxes
the AGENT now, so it belongs beside the thing that spawns one. The proof moved
with it: `platform/tests/integration/confined/cognet-boxed.test.ts` asserts
both directions (denied network blocks, granted network reaches).

`tests/confine/guest-imports.test.ts` was deleted rather than ported. It
enforced that guest code import no runtime modules — a constraint that existed
only because a symlink pointed out of the box. In-process the agent imports
freely, so the rule it protected is gone.

## Key Interfaces

```ts
Capsule(config?)          // run/exec/interrupt/process/scope/on/boot/shutdown
  .boot()                 // load the configured tools
  .run(code)              // execute, resolve with the completion value
  .exec(code, opts)       // ...plus the bindings the submission left behind
  .interrupt()            // cooperative cancellation of every live run
  .update(partial)        // new policy → fresh sandbox, tools reloaded
```

## Known Debt

- ~~8 of 133 tests still fail against the in-process implementation~~ — stale as
  of 2026-09-08: the suite is 180/180. The `escalate` no-callback default no
  longer hangs (`Escalation` answers false immediately when no decider is
  wired), which was the entry most likely to be mistaken for a live issue while
  reading this file.
- Core's suite drops 417 → 400 in a FULL run while the same server tests pass
  103/103 in isolation — cross-test interference from process-global state (the
  cwd restore or the scope install). Worth chasing before the remaining eight:
  a leak between suites is worse than a known gap.
