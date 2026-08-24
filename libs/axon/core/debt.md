## [x] An abandoned stream permanently wedged the runtime
**Severity:** critical
**Description:**
`kernel.stream()` reserved the scheduler synchronously (it must — otherwise two callers
could each mint a wire before either locked), but the only release path lived in the async
generator's `finally`, which never runs if the generator is never iterated. A caller that
created a wire and abandoned it held the lock forever: every subsequent `request()`/`stream()`
threw RUN_IN_PROGRESS until the process restarted. `/_axon/stream` has exactly that shape —
`axon.stream(input)` reserves, then the wire is handed to a ReadableStream whose `start()`
only fires on the client's first read — so a client disconnecting in that window could take
a deployed agent down remotely, and repeatably.
**Resolved.** `Invocation.stream()` now arms a 30s abandonment timer at reserve time,
cleared the instant the generator body starts, so a consumed wire never sees it and an
abandoned one always does. `interrupt()` also aborts-then-releases (in that order — releasing
first would make the abort a no-op against a running wake). Four tests in
`core/tests/integration/handle/abandoned-stream.test.ts`.
**References:**
- libs/axon/kernel/src/scheduler/invocation.ts — the reserve/release window
- libs/axon/core/src/runtime/server/endpoints.ts — /_axon/stream, the remote trigger

## [x] A torn final line made a session unresumable
**Severity:** high
**Description:**
`home.data.sessions.read()` parsed every JSONL line strictly, so one partial line threw and
took the whole session with it — every complete event before it lost too. `appendFile` is not
atomic, so any hard kill mid-append (OOM, SIGKILL, power loss) leaves exactly that. The
asymmetry was backwards: `state.write` used temp+rename and `state.read` caught and returned
null under an explicit cache doctrine, while the session log — the one piece of data in this
system that cannot be rebuilt — had neither.
**Resolved.** `readLines` now skips unparseable lines and keeps the rest. Safe because a
session log is an append-only stream of independent lines: a dropped line loses that event,
not the file's structure, and the `time.seq` gap makes it visible to a reader. Deliberately
NOT the same posture as the capsule wire's strict parse, where a garbage line means the
sandbox is misbehaving right now and must be reported. Four tests in
`packages/session/tests/torn-log.test.ts`.
**References:**
- libs/axon/packages/session/src/home.ts — readLines

## [x] Telemetry writes could crash the runtime they observe
**Severity:** high
**Description:**
Four fire-and-forget commit sites called an async `session.commit()` with no catch: the
capsule's `onAny` forwarder (every capsule event), the cognet ABI's `emit()` (the highest-
volume path in the system), the capsule bus forward, and `boot.vue`'s console capture.
`commit()` rejects on a disk failure and `bus.forward()` can reject on a throwing handler,
so any of these turned a full disk into an unhandled rejection that killed the process — a
telemetry write taking down the thing it exists to observe.
**Resolved.** All four now `.catch(() => {})` with the reasoning recorded at each site.
Losing one telemetry line is the correct trade; these paths are sync by contract (a console
call and the cognet's `emit` cannot await) so a rejection genuinely has nowhere to go.
**References:**
- libs/axon/kernel/src/capsule.ts — onAny forwarder, both branches
- libs/axon/kernel/src/kernel.ts — abi.emit
- libs/axon/core/src/platform/boot.ts — console capture

## [x] axon.tools was a boot snapshot — hot reload never rebuilt it
**Severity:** high
**Description:**
`AxonHandle()` projected the tool map from the boot blueprint once and never
rebuilt it, while exposing it as a plain property. After a hot reload the agent
could call a newly added tool (its capsule had been reloaded) but a script
calling the same tool through `axon.tools.*` got `undefined` — and a tool the
author deleted stayed callable through the handle until restart. Verified
directly: after `update()`, `blueprint.tools` held `["greeter","math"]` while
`Object.keys(axon.tools)` still held `["greeter"]`. Found while building the
host-side tool globals, not by any existing test.
**Resolved.** `tools` is now swappable state behind a getter (the same manager
pattern `Backend`/`AxonCapsule`/`AxonSession` use), re-projected inside
`handle.update()` from the blueprint that just went live.
**References:**
- libs/axon/core/src/runtime/handle.ts — tools getter, update()
- libs/axon/core/tests/integration/handle/tool-globals.test.ts

## [x] tool-globals.d.ts declared globals that did not exist in host-side code
**Severity:** high
**Description:**
`scopeToDts()` emitted every tool into a `declare global` block, and scripts are
compiled against it — but globals were only ever installed inside the capsule
sandbox (`capsule/process/scope.ts`). A script calling `kanban.list()`
autocompleted, typechecked, and threw "kanban is not defined" at runtime. The
docs (`api/tools.md`) described the globals as working everywhere, which is the
behaviour we want; the runtime simply never implemented it. Same
type-lies-about-runtime family as declaring a sync return type for a function
the capsule wraps in a Promise.
**Resolved.** `Inject().runtime()` now binds tool exports as host-side globals,
delegating to the matching `axon.tools.*` proxy so policy, mediation and tracing
cannot drift between the two surfaces. Placement follows `flat` exactly as the
capsule installs it. A name already owned by the host (`fetch`, `axon`, `args`)
is never clobbered — the tool stays reachable explicitly. Globals are retracted
and rebound on reload.
**References:**
- libs/axon/core/src/platform/inject.ts — installToolGlobals(), define()
- libs/axon/kernel/src/scope-dts.ts — doc comment
- apps/axon.arclabs.it/content/docs/v2/api/tools.md

## [ ] Prepare phase has ~120ms of untraced inter-span gaps
**Severity:** medium
**Description:**
The boot trace's interior is now fully accounted for, but the BUILD phase that
precedes it is not. Between `build:framework:complete` → `build:modules:start`
(26ms), `build:modules:complete` → `build:cognet:start` (47ms), and
`build:cognet:complete` → `build:typegen:start` (48ms) roughly 120ms passes with
no span open — likely dynamic `import()` of build machinery, but nothing measures
it so this is inference rather than fact. The same accountability rule the
runtime now enforces (see the gap guard in tests/integration/ontology/spans.test.ts)
should extend to the build recorder, which has its own `span()` helper already.
The clean version is a span around whatever occupies those gaps, and the gap
guard widened to cover `build:*` as well as `axon:boot`.
**References:**
- libs/axon/packages/session/src/build.ts — span(), BuildRecorder
- libs/axon/types/src/session/events/build.ts — BuildEventMap
- libs/axon/core/tests/integration/ontology/spans.test.ts — GAP_BUDGET_MS guard

## [ ] Model catalogue cache cannot revalidate with ETag
**Severity:** low
**Description:**
`CatalogueStore` stores an `etag` field and its `load` callback accepts one, but
nothing populates it: `HttpClient.get()` returns parsed JSON only and does not
expose response headers, so there is no way to read an ETag or send
`If-None-Match` without widening that boundary. Today the cache is purely
time-based (1h fresh / 30d stale-while-revalidate), which is sufficient — the
revalidation happens off the critical path, so its cost is invisible to boot.
The value of adding ETags is bandwidth on the background refresh, not latency.
Worth doing only if `HttpClient` grows a header-returning variant for other
reasons; punching a hole through that seam for this alone is not justified.
**References:**
- libs/cloud/src/registry/models/store.ts — Entry.etag, get()
- libs/cloud/src/platform/http.ts — get() returns parsed body only

## [ ] Two span() helpers with the same contract
**Severity:** low
**Description:**
`libs/axon/packages/session/src/build.ts` and the new `session.span()` implement
the same guarantee — emit `:start`, always close with `:complete` or `:failed`,
carry `durationMs`, repeat opening facts on the closing half. They differ only in
what they commit through (a BuildRecorder vs the session) and in that the build
version needs `as never` casts because its event-name union is hand-written while
the session version is typed against AxonEventMap. This is one idea implemented
twice; the two must not drift, because the flame graph and the gap guard read
both. The clean version is one generic helper parameterized by its emitter, with
the build recorder passing itself in.
**References:**
- libs/axon/packages/session/src/build.ts — span()
- libs/axon/packages/session/src/session.ts — session.span()
