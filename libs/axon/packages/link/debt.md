
## [ ] Stream transport has no real backpressure to the producer
**Severity:** high
**Description:**
`socket.test.ts` ("reaches the producer with backpressure when the consumer stalls")
appears to assert backpressure but does not. Its fixture caps production at 2000 chunks
and it samples after a fixed 250ms, so the assertion passes because the fixture ran out
of work inside the window — not because the producer was slowed. Removing the cap and
waiting for production to settle shows it never settles: measured at 26,569 chunks of
64KB (~1.7GB) buffered with the consumer stalled and no sign of stopping. A model
producing faster than a consumer reads will therefore buffer its entire output in memory,
which is precisely the failure the test was written to prevent. The test was also the
suite's only flake (~1 in 3 under parallel load), because the 250ms window races the
producer on a busy machine. Fix belongs in the transport (honour the sink's backpressure
signal through the async iterator), after which the test can assert that production
settles rather than that it is merely slow.
**References:**
- libs/axon/packages/link/tests/integration/link/socket.test.ts — the test and its note
- libs/axon/packages/link/src/socket.ts — the stream path that should propagate backpressure

## [ ] `time` is re-stamped at the supervisor, so log timestamps are receipt time
**Severity:** medium
**Description:**
A confined agent commits over the link and the supervisor re-envelopes on
arrival, minting a fresh `time.ms` and `time.seq`. `seq` MUST come from the
supervisor — it owns the file and a single serialized writer is what makes the
sequence authoritative — but `ms` need not, and today every event's wall clock
is when the supervisor received it rather than when the agent emitted it. Under
load, or across a busy link, those diverge: anything measuring latency from the
log is measuring the supervisor's drain rate, not the agent's work. The clean
version carries the agent's emit time alongside the supervisor's seq, so the
envelope can say both "when it happened" and "where it sits in the order" —
the same split the correlation ids now get after the `ctx` fix.
**References:**
- libs/axon/platform/src/link/agent-main.ts — announce(), where the envelope is unwrapped
- libs/axon/packages/session/src/session.ts — envelope(), which stamps the replacement

## [x] `TMPDIR` was not passed to agents, breaking tool loading on macOS
**Severity:** critical
**Description:**
Tool loading materialized bundled source to `join(os.tmpdir(), …)` and imported
it. `os.tmpdir()` reads `TMPDIR`, and the agent process is spawned with an
environment built from nothing — `floorEnv()` passes nine names and `TMPDIR` is
not among them. So the host resolved one directory and the agent resolved
another. On macOS the host has `TMPDIR=/var/folders/…` while the agent fell back
to `/tmp` (a symlink to `/private/tmp`), every tool import failed, and the agent
could not boot at all. RESOLVED: materialization moved to the agent's own frame
cache (`.agent/cache/tools`), derived from `blueprint.paths` and resolved
against the agent root, so it asks the process for nothing. The two duplicate
implementations (core's `tools/load.ts` and the capsule's `process/scope.ts`,
both shipping into the same agent bundle) collapsed into one shared module.
**References:**
- libs/axon/packages/capsule/src/process/materialize.ts — the one implementation
- libs/axon/packages/link/src/confined.ts — floorEnv(), now exported and tested
- libs/axon/packages/link/tests/unit/floor-env.test.ts — the guard

## [ ] Cross-platform paths are exercised on one OS only
**Severity:** high
**Description:**
The TMPDIR bug shipped because every test runs on Linux, where `TMPDIR` is
usually unset — so the host and the agent both fell back to `/tmp` and agreed by
COINCIDENCE. The integration suites do spawn real agents through the real
`spawnConfined`, so the seam was covered; what was not covered is the seam
behaving differently when an ambient variable is present. Two gaps compound
here: `floorEnv` had no test at all (its sibling `resolveEnv` had nine), and
nothing anywhere asserted that a path-producing code path is independent of the
environment. The durable fix is probably a small suite that runs the
env-sensitive paths under a deliberately hostile environment (TMPDIR set to a
decoy, HOME moved, PWD stale) rather than CI on three operating systems — the
property that broke is "does this read ambient state", which is testable on one
box. Worth doing before the next path bug rather than after.
**References:**
- libs/axon/packages/link/tests/unit/floor-env.test.ts — the shape to extend
- libs/axon/packages/capsule/tests/materialize.test.ts — asserts env-independence
