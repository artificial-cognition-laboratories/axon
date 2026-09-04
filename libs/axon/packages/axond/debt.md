# @arcforge/axond — Debt

## [x] "The second agent spawned never answers" — was a test budget, not a wedge
**Severity:** low (was: high)
**Description:**
RESOLVED, and the original diagnosis was wrong twice over. Reported first as a
race between concurrent invocations, then sharpened to "the second agent spawned
in one supervisor process never answers". Neither was true.

The test spawns two agent PROCESSES and serves three wakes on a 30s budget.
Measured 17-25s warm, longer cold — so it timed out intermittently, which read
as a hang in the runtime. Every sibling that both spawns and invokes is already
at 90-180s. Raised to 120s; stable across repeated runs.

Two things made this look like a runtime fault far longer than it should have,
and both are worth remembering:

- The diagnostic probes used `Promise.race` against a timeout. An abandoned
  `request` leaves the scheduler's EXCLUSIVE reservation held (invocation.ts
  documents the window and guards it with a 30s ABANDON_MS), so every probe
  poisoned the agent it was measuring and the NEXT request genuinely failed
  with RUN_IN_PROGRESS. The probe manufactured the symptom it was hunting.
- Agent stderr is captured but only surfaced when a boot never connects, so a
  healthy-but-slow agent is silent by construction.

Two real defects found while tracing are FIXED and were never the cause: link
correlation ids collided across the two sides (both minted
`${Date.now()}-${counter++}` from a counter starting at 0 per process, verified
to overlap completely — ids now carry a per-channel random origin), and
`dispatch` dropped a reply with no matching pending entry silently rather than
reporting it through `onError`.

**References:**
- tests/integration/agents/spawn.test.ts — "runs two instances of the same agent with separate cognet kernels"
- libs/axon/packages/link/src/channel.ts — nextId origin, orphan-reply reporting
- libs/axon/kernel/src/scheduler/invocation.ts — the abandonment window the probes fell into

## [x] `axon update` left a stale daemon running forever
**Severity:** critical
**Description:**
The update path is install → verify → rollback and never touches the daemon,
while `lifecycle.up()` returned `already` on the strength of a live pid alone.
So after an update the new CLI talked to whatever was already listening —
indefinitely, since `up` runs before every agent command and nothing ever told
the user to restart. Observed with 28h uptime across a day of releases: the CLI
dispatched verbs the old process had never heard of and got DAEMON_NOT_WIRED,
which surfaced as a hang. The one diagnostic that should have revealed it made
it invisible — `status()` reported `opts.version`, the CALLER'S build, so a
stale daemon confirmed itself current to whichever CLI asked. Fixed by
recording the serving build in the pidfile, comparing it in `up()`, and
reporting the running version rather than the asker's.
**References:**
- libs/axon/packages/axond/src/control/lifecycle.ts — readRecord, claim, up, status
- libs/axon/packages/axond/tests/unit/lifecycle.test.ts

## [ ] A daemon restart disposes every agent it supervises
**Severity:** medium
**Description:**
`agents.dispose()` stops every supervised agent on shutdown, so replacing a
stale daemon ends whatever was running. Handled by refusing when agents are
live (`onStale`) and reporting DAEMON_STALE with the fix — but that leaves a
user mid-session after an update having to stop their own agents before the CLI
will work. The better answer is a handover: the new daemon adopts the running
records rather than the old one disposing them, which the registry already
makes possible since every agent is its own process reached over its own
socket. Worth doing before updates become frequent enough that this is a daily
papercut.
**References:**
- libs/axon/packages/axond/src/agents/agents.ts — dispose
- libs/axon/packages/axond/src/control/lifecycle.ts — the onStale seam


## [ ] `AxonAgentHandle.stream()` is unreachable — no caller, so its contract is unverified
**Severity:** low
**Description:**
Nothing in the repo calls `stream()` on an agent handle: `Instance.stream()`
forwards to it and is itself uncalled, and the daemon's control surface never
exposes it. That is how its event-shape bug survived — it rebuilt bus payloads
as `{ type, data }` when the payload was already an envelope, double-wrapping
every entry, and an `as AxonEntry` cast silenced the mismatch. Fixed now (it
forwards the envelope and filters with `isEntryEvent`), but the verb is still
dead code with no test, so the next change to it has nothing holding it honest.
Either wire the caller it was built for (streaming a stimulus over the daemon)
and test it, or remove it until that caller exists.
**References:**
- libs/axon/packages/axond/src/agents/handle.ts — DirectHandle stream()
- libs/axon/packages/axond/src/agents/instance.ts — the forwarder, also uncalled

## [x] The boot unit has never started — ExecStart names a binary systemd cannot execute
**Resolved 2026-09-01:** `Boot.install()` now resolves the command's binary to an
absolute path via `Bun.which` before writing the unit, and refuses to install
when it cannot be found rather than writing one that fails at boot. `installed()`
compares against the same resolved form, so an install repairs a stale path.
**Severity:** critical
**Description:**
`Boot()` writes `ExecStart=axon daemon serve`, a bare command name. systemd
does not search the session PATH for ExecStart, and the installed unit fails
with `status=203/EXEC` on every attempt — `systemd-analyze --user verify` says
it plainly: "Command axon is not executable: No such file or directory". The
unit is installed and `enabled`, so it reports healthy and has never run. With
`Restart=on-failure` it also loops silently. This defeats the daemon's entire
premise — resident, supervised, starts with the machine — and it is exactly the
failure the `bootCommand` doc comment warns about ("a unit naming a binary that
does not exist fails silently at boot"), reached by a route the comment did not
anticipate.

Two causes compound. systemd resolves a bare ExecStart name only against a
fixed set of system directories, never the user's PATH. And the Axon installer
adds its bin directory to `~/.bashrc` and `~/.zshrc` only, so `axon` exists in
interactive shells and in no other context — not systemd units, not desktop
entries, not cron. Verified on this machine: `axon` resolves to
`~/.cache/.bun/bin/axon`, which appears in neither the graphical session's PATH
nor any directory systemd will search.

The fix is to resolve the CLI to an absolute path when the unit is written,
rather than trusting a name to be findable later — while keeping the property
the current comment is protecting, that the unit must not name a versioned or
source path that breaks on upgrade. A launcher installed at a stable location
on the session PATH (`~/.local/bin`, which IS on it) would satisfy both.
**References:**
- libs/axon/packages/axond/src/axond.ts:77 — `command: opts.bootCommand ?? ["axon", "daemon", "serve"]`
- libs/axon/packages/axond/src/control/boot.ts — BootOpts.command, unit writing
- apps/axon.arclabs.it/public/install — writes PATH to shell rc files only

## [x] `held` double-counts a weight two agents share
**Resolved 2026-09-01:** `Residency.held()` counts each model once. `admit()` and
`Machine.state()` both had their own re-derived sums — the second was found
while fixing the first — and now share the domain's one answer. Verified on
real hardware: three holds, two sharing a weight, reported 11.55 GB against an
11 GB card and now reports 5.96 GB.
**Severity:** high
**Description:**
`Residency.held()` is `live().reduce((total, hold) => total + hold.bytes, 0)` —
a plain sum with no deduplication by model. But the models domain exists
precisely so there is ONE resident copy of a weight however many agents hold
it, so two agents sharing a 6.2 GB weight produce two holds of 6.2 GB and a
reported 12.4 GB against a machine using 6.2 GB.

This contradicts the comment in `admit()`, which states that our own accounting
"can only under-report, never over" — the shared-weight case is exactly the
over-reporting direction that comment rules out. The consequence is functional,
not cosmetic: `admit()` uses `usage.vramUsed ?? held`, so on any machine whose
video memory cannot be probed it falls back to `held` and refuses loads that
would have fit. That fallback is not rare — `Hardware` reads NVIDIA and Apple
only, so every AMD and Intel machine takes it, and those are most Linux
desktops.

`MachineState.held` carries the same error to every consumer, including the
Omarchy panel's HELD tile and the share drawn inside its VRAM chart.

The fix is to sum distinct models rather than holds — the hold already names
its model, so the tenancy list stays as it is and only the total changes.
**References:**
- libs/axon/packages/axond/src/machine/residency.ts:78 — held()
- libs/axon/packages/axond/src/machine/machine.ts — admit(), `usage.vramUsed ?? held`
- libs/axon/packages/axond/src/machine/hardware.ts — why the fallback is common

## [ ] The llama.cpp adapter is unexercised against a real weight
**Severity:** medium
**Description:**
`LlamaAdapter` is written and registered, and everything reachable without the
native library is verified: claim-by-magic-bytes routes a GGUF named `.bin` to
llama.cpp and refuses a non-GGUF named `.gguf`, and `load()` reports
MODEL_RUNTIME_MISSING rather than crashing when `node-llama-cpp` is absent.

What has NOT run is a load and a completion, because the binding is an optional
dependency and is not installed here. The module shape is declared locally
against node-llama-cpp v3 — `getLlama`, `loadModel`, `createContext`,
`LlamaChatSession` — and a v3 API change would surface as a load failure rather
than a type error, since an optional package cannot be type-imported without
making the build require it.

Installing it and running one GGUF end to end is the missing verification.
**References:**
- libs/axon/packages/axond/src/models/llama.ts — the local module types
- libs/axon/packages/axond/package.json — optionalDependencies

## [ ] Cancelling a download does not stop the bytes
**Severity:** low
**Description:**
`Downloads.cancel` marks a transfer cancelled and discards its result, which is
what a person clicking cancel is asking for. It does not abort the request: the
fetcher reads the body to completion with no `AbortSignal` wired through, so a
five-gigabyte transfer keeps arriving in the background until it finishes and
is then thrown away.

The fix belongs in the fetcher rather than the registry — `readWithProgress`
already holds the reader, so threading a signal through `FetchOpts` and calling
`reader.cancel()` is the shape. Recorded rather than done because a half-aborted
transfer must not leave a partial file at a content-addressed path, and `put()`
is what guarantees that today.
**References:**
- libs/axon/packages/axond/src/models/downloads.ts — cancel()
- libs/axon/platform/src/build/project/models/fetch.ts — readWithProgress

## [ ] A cache hit still creates a download record
**Severity:** low
**Description:**
`models.download` on a weight already in the store runs to completion instantly
and leaves a record reading `0 B, done` — technically true and briefly
confusing, since nothing was transferred. Either the record should say "already
cached" or no record should be created for a hit. The store knows before the
transfer starts, so the check is cheap.
**References:**
- libs/axon/packages/axond/src/models/models.ts — download()

## [ ] Jobs are recorded but nothing boots them
**Severity:** high
**Description:**
`Jobs` takes a `start` thunk and `Axond` forwards `opts.startJob`, but nothing
supplies one — so every job is created and stays `queued`. Booting a job's agent
needs a PREPARED blueprint, and preparing one needs the platform's project
stack, which is deliberately not in the daemon. The next step is the `axon job
create` path handing a prepared blueprint through, and the job record storing it
so a retry or a boot-time wake can re-use it without a CLI standing by.
**References:**
- src/jobs/jobs.ts — JobsOpts.start
- src/axond.ts — AxondOpts.startJob

## [ ] A job's agent reports nothing back
**Severity:** high
**Description:**
`say`, `block` and `finish` exist on the domain and no agent calls them, so a
running job never progresses past `running` on its own. The agent side needs to
reach the daemon with its own session as the actor — `AXON_SESSION_ID` is
already set on every confined incarnation, so the actor resolution is done; what
is missing is the agent-side call.
**References:**
- src/jobs/jobs.ts — say/block/finish
- src/agents/credential.ts — actor()

## [ ] The claim lease is recorded and never enforced
**Severity:** low
**Description:**
`start` writes a `claimed` event with a five-minute lease and nothing ever
checks it. That is correct today — one daemon means nothing to enforce against —
but a shared job needs a stale claim to expire and be re-claimable, and the
check has to land with the multi-machine work rather than after it.
**References:**
- src/jobs/jobs.ts — LEASE_MS, the "claimed" event

## [ ] A cached model cannot say whether it recognises or synthesises speech
**Severity:** high
**Description:**
`capability: "speech"` covers both automatic-speech-recognition and
text-to-speech, and on a CACHED record nothing separates them: `type` is
`"transform"` for both, `in`/`out` are empty arrays, and `description` (which
carries the pipeline tag for catalogue entries) is null. So the dictation
engine dropdown in Settings currently lists Kokoro — a synthesis model that
cannot transcribe — beside Whisper, and choosing it would bind a shortcut to a
guaranteed failure. The daemon already resolves this correctly at RUN time:
`transformers.ts: taskFor()` reads the architecture from `config.json` and
refuses synthesis outright. The clean version runs that determination when the
record is built and reports it, so every reader gets the same answer the
runtime would. Guessing from the model name in the panel would be a second,
worse copy of a decision the daemon already makes properly.
**References:**
- libs/axon/packages/axond/src/models/transformers.ts — taskFor(), the authority
- libs/axon/packages/axond/src/models/catalog.ts — PIPELINE_TAGS, capabilityOf()
- libs/axon/packages/omarchy/views/browser/pages/Settings.qml — speechModels

## [x] Whisper hallucinates words on silence, and dictation types them
**Severity:** medium
**Description:**
A dictation keypress with no speech behind it does not produce an empty
transcript — Whisper confabulates. Measured: 11.7 seconds of a quiet room
transcribed as "you", which dictation then typed into the focused window.
`Dictation.stop()` already declines to type an EMPTY transcript, but empty is
not what a silent recording produces. The tempting fix — a blocklist of the
handful of strings Whisper is known to emit ("you", "Thank you.", "Bye.") — is
a guess dressed as a rule and would silently swallow someone genuinely saying
"you". The real answer is voice-activity detection before the audio reaches the
model, so a recording with no speech in it is never transcribed at all. Until
then an accidental keypress can type a word.
**References:**
- libs/axon/packages/axond/src/dictation/dictation.ts — stop(), the empty-transcript guard
- libs/axon/packages/axond/src/dictation/capture.ts — where VAD would sit

**Resolved.** `Segments` gates every model pass on a duty cycle, not a peak:
a stretch must be above the amplitude floor for at least 30% of its windows to
count as speech. That is what separates talking (above the floor most of the
time) from a room with typing in it (a few percent), and it is a property of
the signal rather than a blocklist of the words one model happens to invent.
Verified: six seconds of a quiet room with typing now returns `""` and runs no
inference at all — the exact input that previously produced "you you".

## [ ] Speech recognition runs on the CPU while the GPU sits idle
**Severity:** medium
**Description:**
`transformers.pipeline()` is called with no `device`, and the bundled
`onnxruntime-node` ships CPU-only — there is no CUDA or Vulkan provider in
`bin/napi-v6/linux/x64/`. So Whisper transcribes at roughly 4-8x realtime on
the CPU while an RTX 2080 Ti is idle. This is not a flag: it is a distribution
question, and the obvious routes each carry a real cost. Arch's `whisper-cpp`
depends on `ggml`, which is built CPU-only, so the packaged binary is no better.
`onnxruntime-node` with the CUDA EP needs the CUDA toolkit and cuDNN, which is a
heavy ask of someone installing a desktop plugin. The promising lead is that
`node-llama-cpp` ALREADY ships prebuilt CUDA and Vulkan binaries in this tree
and reports `llama.gpu === "vulkan"` on this machine — so GGUF models are
GPU-capable today, and a whisper.cpp binding distributed the same way (prebuilt
per-platform via npm optional deps, Vulkan rather than CUDA to avoid the
toolkit) would need no system dependencies at all. Streaming has reduced the
urgency: the wait at the end is now one tail segment rather than the whole
recording.
**References:**
- libs/axon/packages/axond/src/models/transformers.ts — pipeline(), no device
- libs/axon/packages/axond/src/models/llama.ts — getLlama(), already on Vulkan

## [ ] Arch's whisper-cpp cannot run — do not offer it again
**Severity:** low
**Description:**
A one-click install flow for `extra/whisper-cpp` was built and removed, because
the package is broken as shipped. It installs cleanly and aborts on every model
load with SIGABRT: `extra/ggml` ships only `libggml-base.so` and `libggml.so`
and no compute backend at all, so ggml finds no plugins in `/usr/lib/ggml` (a
directory the package never creates), zero devices register, and
`GGML_ASSERT(device)` fails. The only supplier of the CPU backend is
`aur/ggml-cpu-backend`, orphaned at zero votes.

Recorded because every cheap check for this reports success: the binary is on
PATH, `ldd` is clean, `--help` exits 0, and the backend SYMBOLS are present in
`libggml-base.so` — they are simply never registered as a device. Detection by
presence would have routed dictation into a runtime that cannot execute
anything, turning a slow feature into a dead one. If this is revisited, the
only honest probe is running the binary against a real model and reading the
exit code (134).
**References:**
- libs/axon/packages/axond/src/models/transformers.ts — the runtime actually in use
