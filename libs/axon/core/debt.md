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
