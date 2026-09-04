# @arcforge/err — Debt

## [x] Duplicate `MODEL_NOT_CACHED` key silently shadows the manifest error
**Severity:** medium
**Description:**
`map.ts` defines `MODEL_NOT_CACHED` twice for two genuinely different failures:
`AX-MODEL-004` (a `--frozen` manifest assertion, `source: "manifest"`,
`severity: "fatal"`) and `AX-MODEL-035` (a daemon cache miss, `source: "daemon"`,
`severity: "degraded"`, `expected: true`). The second wins, so a `--frozen` drift
is currently reported with the daemon's message and as a degraded, expected
condition rather than a fatal one — the user is told a weight was not fetched
when what actually happened is that their lockfile disagreed with the machine.
`tsc` reports it as TS1117, so it is visible on any typecheck of a package that
builds this file. The clean version is two distinct names; picking them means
deciding which callers mean which, so it is not a silent rename.
**References:**
- src/map.ts:683 — `AX-MODEL-004`, the manifest/`--frozen` meaning (shadowed)
- src/map.ts:2363 — `AX-MODEL-035`, the daemon cache-miss meaning (wins)

**Resolved.** The daemon-side entry (`AX-MODEL-035`) is now `MODEL_NOT_ON_MACHINE`;
`MODEL_NOT_CACHED` keeps `AX-MODEL-004` and the manifest/`--frozen` meaning, which
is what its one caller (`platform`'s models.ts, under `resolveOpts.frozen`) always
meant. The daemon variant had no callers, so the rename moved the unused half.

