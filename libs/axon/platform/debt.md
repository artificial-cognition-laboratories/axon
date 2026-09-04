# @arcforge/platform — debt

## [x] The Vue and TypeScript toolchains loaded eagerly on every import
**Severity:** high
**Description:**
Importing the blueprint cost ~462ms and importing `@arcforge/core` ~341ms, before
either did any work. Two heavyweight dependencies were pulled in at module
scope by files that only need them conditionally:

- **`@arcforge/vstr`** (~280ms) carries the entire Vue toolchain — `@vue/compiler-sfc`,
  `runtime-core`, `server-renderer`, `turndown`. Imported eagerly by
  `blueprint/scan/prompts.ts`, `core/runtime/source/render.ts` and
  `core/platform/boot.ts`, though it is only used to introspect or render a
  `.vue` prompt. An agent with no `.vue` prompts paid it in full, as did every
  request rendering a static prompt.
- **`typescript`** (~175ms) imported eagerly by `blueprint/scan/scripts.ts`,
  `modules/meta.ts` and `scan/moduleImports.ts`. Reading an agent's config
  meant loading the whole compiler whether or not there was anything to parse.

Both are genuinely needed sometimes, so neither can be removed — but paying for
them at import time meant every `axon` invocation paid for capabilities most
never touch.

**Resolved.** Each is now loaded on first use and memoised behind a module-level
promise, so a caller that needs it pays once and one that doesn't never loads it.
`ts` node types moved to a type-only `import type TsNamespace` so the helper
signatures stay unchanged while the runtime binding is populated lazily.

| | before | after |
|---|---|---|
| `blueprint` import | 462ms | **29ms** |
| `@arcforge/core` import | 341ms | **42ms** |
| both + `dave` load | ~1806ms (pre-cache fix) | **~420ms cold, ~60ms warm** |

The remaining cold cost is `typescript`, now paid only by agents that actually
parse a module config, once per process. Agents with no modules
(fragcheck, dungeon-master) load in 2–4ms.

Verified: core 253 pass, platform 452 pass, blueprint output byte-identical to
baseline across six agents (including `scout`'s 4 introspected props), and both
of `repo-state`'s `.vue` prompts render correctly through the lazy path — that
last one by hand, because no test covers `.vue` prompt rendering.
**References:**
- libs/axon/platform/src/build/blueprint/scan/prompts.ts — lazy vstr
- libs/axon/platform/src/build/blueprint/scan/scripts.ts — lazy ts + tsast
- libs/axon/platform/src/build/blueprint/scan/moduleImports.ts — lazy ts
- libs/axon/platform/src/build/blueprint/modules/meta.ts — lazy ts
- libs/axon/core/src/runtime/source/render.ts — lazy vstr
- libs/axon/core/src/platform/boot.ts — lazy vstr

## [x] Gaps in prompt-render coverage
**Severity:** medium
**Description:**
An earlier note here claimed `.vue` prompt rendering was untested. That was
wrong — `core/tests/integration/handle/prompt-vuedown.test.ts` already covered
four cases including a live capsule tool call from `<script setup>`, and
`prompt.test.ts` covered the static path and both not-found errors. The real
gaps were narrower: the `PROMPT_RENDER_FAILED` wrapper (the whole reason the
vstr call sits in a try/catch) had no test, `promptContext` was never asserted
as reaching a component, and nothing pinned the laziness the boot work depends
on.
**Resolved.** Added cases for a malformed SFC and a throwing `<script setup>`
(both must surface as `PROMPT_RENDER_FAILED` rather than a raw vstr Error),
blueprint context reaching a template, `list()` enumeration, and a regression
test asserting the Vue toolchain is NOT in the module graph until a `.vue`
prompt is actually rendered.
**References:**
- libs/axon/core/tests/integration/handle/prompt-vuedown.test.ts
- libs/axon/core/tests/integration/handle/prompt-lazy.test.ts

## [x] Source modules could never cache tool declarations — 1.4s on every boot
**Severity:** high
**Description:**
`cacheDir()` in `build/blueprint/scan/tools.ts` located the tool caches by
looking for an existing `.agent`/`.module`/`.cognet` directory and returned
`null` when the root had none. Null meant "no cache" — so the declaration and
bundle results were neither read nor **written**, and the two subprocess workers
(`ts.createProgram()` and `Bun.build()`) respawned on every scan, forever.

The roots that hit it were exactly the ones that most need a cache: a source
module developed in place has no generated-output directory until something
builds it. `registry/modules/discord` had none, so `registry/agents/dave` paid
~1.4s of its ~1.8s `blueprint.load()` re-deriving results whose inputs had not
changed — on every boot AND every watcher reload. Measured in-process, three
consecutive `Modules()` calls cost 1322/1348/1323ms: not a cold-start cost, an
unconditional one. Agents with no source module (barry.mk3, fragcheck) loaded in
4–24ms, which is why this never looked like a systemic problem.

**Resolved.** `cacheDir()` now creates `.module/` when the root has none,
falling back to `null` only if creation fails (a read-only root still scans, it
just pays the uncached cost — a cache must never fail a boot). `dave`'s
`blueprint.load()` went 1806ms → 174ms cold / ~10ms warm.

Invalidation was verified rather than assumed: the caches are keyed on a
content hash of every tool file, so editing a tool rebuilt (7ms → 1341ms) and
the new export appeared in both the declare and bundle caches. This is the
mechanism that was already correct — it simply never had a directory to live in.

`**/.module` was added to the root `.gitignore` alongside `**/.agent`, since the
scanner now creates it in any module root. Deliberately NOT `**/.cognet`:
`registry/cognets/*/.cognet` holds tracked published bundle artifacts.

**Remaining boot cost** (~174ms cold, ~10ms warm) is dominated by one-time
module evaluation of `axon.config.ts` (147ms first call, 1ms after) — inherent
to loading the config, not repeated work.
**References:**
- libs/axon/platform/src/build/blueprint/scan/tools.ts — cacheDir()
- .gitignore — `**/.module`

## [x] Tool scan could succeed with an empty result, and cache it forever
**Severity:** critical
**Description:**
`declareTools()` answered a `.d.ts` lookup miss with `continue`, so a file that
emitted no declaration silently vanished from the result. The worker reported
`ok: true` with a short list, `cachedDeclarations()` wrote that emptiness to
`tools-declare-cache.json` keyed on the source hash, and `Tools()` degraded a
throw to a warning — which `runtime/agent.ts` then discarded entirely by
destructuring `{ blueprint }` and dropping `warnings`. Net effect: one
non-normalized path (any `/a/./b.ts`, or a Windows path with backslashes)
produced an agent with zero tools, permanently, recoverable only by editing the
source or deleting the cache by hand. Reported by a user whose
`tools-bundle-cache.json` held the tool while `tools-declare-cache.json` held
`"files": []` at the same `inputHash`.
**Resolved.** Paths are normalized on both sides of the lookup via `ts.sys.resolvePath`;
a missing declaration throws `TOOL_DECLARE_FAILED` with the compiler's own
diagnostics appended; incomplete results throw rather than caching; `Tools()`
no longer catches either failure. Corrupt caches are treated as a miss and
rebuilt, and cache writes are atomic (temp + rename).
**References:**
- libs/axon/platform/src/build/blueprint/scan/declare.ts — normalize(), diagnosticsFor()
- libs/axon/platform/src/build/blueprint/scan/tools.ts — cachedDeclarations(), cachedToolBundles(), readCache(), writeCache()
- libs/axon/platform/tests/unit/tools/ — declare, cache, bundle, merge, scope-render
- libs/axon/platform/tests/integration/tools/ — failures, runtime

## [x] Tool declarations described the unwrapped function, not the callable value
**Severity:** high
**Description:**
The capsule wraps every tool export in an async mediation wrapper
(`capsule/process/scope.ts`), so a call returns a Promise whatever the author
wrote — policy is checked first, and an `escalate` rule is a round trip to the
user that cannot be synchronous. But `declareTools()` emitted the author's raw
signature, so a sync-authored tool was declared `(a, b): number` in both the
model's `<scope>` block and `.agent/tool-globals.d.ts`. A model told `number`
writes `add(1, 2) * 2` and gets `NaN` with no error and no trace event; an
author gets editor autocomplete that disagrees with the runtime.
**Resolved.** `awaitable()` lifts non-Promise return types at the point
`ToolFnEntry.declaration` is built, uniformly, because the wrapper is uniform.
Sync bodies remain fully supported — only what the model and editor are TOLD
changed. Docs updated to state that every tool is called with `await`.
**References:**
- libs/axon/platform/src/build/blueprint/scan/declare.ts — awaitable()
- apps/axon.arclabs.it/content/docs/v2/agent/src/tools/index.md
- apps/axon.arclabs.it/content/docs/v2/agent/build/tools.md

## [ ] `Scanned<T>.warnings` has almost no consumers
**Severity:** medium
**Description:**
Six scanners (prompts, scripts, routes, plugins, middleware, boot) still return
warnings, and the only readers in the repo are `apps/tui/cli/agent.ts:142` and
`:170` — the `prepare` and `dev` CLI paths. `runtime/agent.ts` destructures
`{ blueprint }` and drops them, so anything a scan warns about during a boot or
a watcher reload is invisible. The tools domain no longer uses the channel (its
failures throw), but the shadowing warnings from `collisions.ts` are genuinely
correct as warnings and currently reach nobody at runtime. Either wire warnings
into the session log at boot/reload, or decide per-domain which ones are
actually invalid states and make those throw too.
**References:**
- libs/axon/platform/src/build/runtime/agent.ts:52,105 — warnings discarded
- libs/axon/platform/src/build/blueprint/collisions.ts — shadowing warnings
- apps/tui/cli/agent.ts:142,170 — the only consumers

## [x] `api/tools.md` documents a script-land global scope that does not exist
**Severity:** medium
**Resolved.** The docs described the behaviour we wanted; the runtime was what
was missing. `Inject().runtime()` now installs tool globals host-side (see
libs/axon/core/debt.md), so the page and the `.d.ts` are both honest. The page
was rewritten anyway — its generated-declaration example was stale, and it now
documents `axon.tools.*` as the explicit path alongside the globals.
**Description:**
The page states tools are callable as bare globals from scripts, routes and
hooks with no prefix. No code path installs tool globals into the host process —
`process/scope.ts` builds them for the capsule sandbox only, and script-land
reaches tools through `axon.tools.<file>.<fn>` (`core/src/runtime/source/tools.ts`).
`scopeToDts()` nonetheless declares them inside `declare global`, so a script
gets autocomplete for a global that is absent at runtime: the same
type-lies-about-runtime family as the Promise bug, and the reason the page reads
plausibly. Its `tool-globals.d.ts` example is also stale (shows
`typeof import(...)`; the real generator inlines declarations). Decide whether
script-land should get real globals or whether the `.d.ts` should stop declaring
them, then correct the page.
**References:**
- apps/axon.arclabs.it/content/docs/v2/api/tools.md
- libs/axon/kernel/src/scope-dts.ts — declares globals for all contexts
- libs/axon/core/src/runtime/source/tools.ts — the actual script-land surface

## [x] Promise lifting emitted invalid TypeScript for type predicates
**Severity:** high
**Description:**
`awaitable()` wrapped every non-Promise return type, including type predicates:
`function isStr(x: unknown): Promise<x is string>` does not parse. `x is T` is
only legal in a bare return-type position. The broken declaration reached both
the model's `<scope>` block and `.agent/tool-globals.d.ts`. Found by an
adversarial pass, not by the original suite — every assertion there used
`toContain()`, which a syntactically broken declaration still satisfies.
**Resolved.** `ts.isTypePredicateNode()` short-circuits the lift; predicate
narrowing is erased by serialization across the capsule boundary regardless.
Declaration tests now parse what they emit rather than substring-matching it.
**References:**
- libs/axon/platform/src/build/blueprint/scan/declare.ts — awaitable()
- libs/axon/platform/tests/unit/tools/adversarial.test.ts — assertParses()

## [x] Ambient type collisions silently gave one tool another's type
**Severity:** high
**Description:**
The ambient-type pool in `declareTools()` is global and was first-wins by name.
Two tool files each declaring `type Result` with different shapes meant the
second tool was declared as returning the FIRST file's shape — the model told a
function returns `{ kind: 'a' }` when it returns `{ kind: 'b' }`. Nothing
downstream can detect this: the scope renders, the .d.ts compiles, the tool
loads. Same class as the original reported bug (a scan that succeeds while
producing something other than what the author wrote) reached by a different
route.
**Resolved.** A tool's own file wins for any name it declares; resolving through
the shared pool to a name several files define differently throws
`TOOL_DECLARE_FAILED` naming the type and suggesting the fix. Two files
privately reusing a name they never expose remains legal.
**References:**
- libs/axon/platform/src/build/blueprint/scan/declare.ts — conflicting/declsByFile
- apps/axon.arclabs.it/content/docs/v2/agent/src/tools/index.md

## [ ] Existing running/ store directories are group- and world-readable
**Severity:** medium
**Description:**
`Running().start()` now creates `<store>/running` as 0700 and its records as
0600, because an `AxonInstance` may carry the control channel's token — the
only thing standing between another local account and a socket that can drive
the agent. Directories created before this change are 0775 on disk
(`~/.axon/running`, `~/.axon-dev/running` were both observed as `drwxrwxr-x`).
The explicit `chmodSync` in `start()` repairs them on the next TUI boot, so
this closes itself on any machine that runs an agent — but until then, an
existing install has a world-readable store, and any machine that never boots
a TUI again keeps it. The clean version is a one-shot migration in store
setup rather than relying on the write path to heal it.
**References:**
- libs/axon/platform/src/services/running/running.ts — start()

## [ ] Control channel has no subscription surface
**Severity:** low
**Description:**
`Dispatch` implements `rpc.subscribe`/`rpc.event`/`rpc.unsubscribe` and both
transports carry them, but neither `ControlServer` nor `ControlClient` exposes
a public `subscribe()` — v1 has no streaming consumer, so the frames are wired
but unreachable. This is deliberate (the surface gets designed when something
needs it, not guessed at now) and is recorded so the gap is not mistaken for an
oversight later. The first real consumer — most likely the extension tailing a
live session's events — should add the surface and the test together; the
suite currently documents its own absence rather than reaching into Dispatch
to fake one.
**References:**
- libs/axon/platform/src/services/control/dispatch.ts — subscribe()
- libs/axon/platform/tests/integration/services/control.test.ts

## [x] Module tools install flat, colliding silently with the agent's own
**Severity:** high
**Description:**
`Tools()` sets `flat: true` for every tool file it scans, and
`modules/index.ts` re-tags a module's tools with `origin: "module"` without
clearing it. So module tools install as TOP-LEVEL globals, not under the
module's name — contradicting `agent/modules.md` ("Module contributions are
prefixed to prevent collisions… Module tools use the module name") and
`axon.tools.<module>.*` throughout the docs.

The consequence is a silent wrong answer, not a visible error. An agent tool and
a module tool both exporting `openPr` produce two identical
`function openPr(...)` declarations in one `declare global` block, and the
capsule builds its scope with `Object.assign` over flat tools
(`capsule/src/process/scope.ts:145-147`) — so whichever loads last wins and the
other is unreachable. `merge()` cannot catch this: it dedupes on the TOOL name
(the filename, `mine` vs `prs`) while the collision is between the FUNCTION
names inside them. Verified end to end against a real module on disk.

Not fixed in place because it is a design decision, not a one-line change.
Setting `flat: false` alone yields `prs.prs.list()`: registry modules export a
single object named after the file (`export const prs = {...}` in
`registry/modules/github/src/tools/prs.ts`), a convention written for flat
placement. The real fix decides what a module tool's namespace is — the module
name (`github.*`, as documented) or the filename (`prs.*`, as the code implies)
— and migrates the registry modules to match. Until then, an agent installing a
module whose tool exports collide with its own gets one of them silently.
**References:**
- libs/axon/platform/src/build/blueprint/modules/index.ts — moduleTools re-tag
- libs/axon/platform/src/build/blueprint/scan/tools.ts:291 — flat: true
- libs/axon/packages/capsule/src/process/scope.ts:143-150 — Object.assign
- registry/modules/github/src/tools/prs.ts — the object-per-file convention
- apps/axon.arclabs.it/content/docs/v2/agent/modules.md:60-72 — documented prefixing

**Resolved:** `flat` is deleted. It was never once set false anywhere in the repo, so the namespaced branch it guarded had never executed — the rule is now what the code always did: every export from `src/tools/*.ts` lands in the agent's global scope under its own name, filename groups rather than namespaces. Tool-vs-tool collisions are fatal at install (`TOOL_GLOBAL_COLLISION`) instead of last-one-wins; a tool shadowing a host builtin is allowed, since `@axon/fs` exporting `fs` is the author's explicit declaration.

## [x] Every scan surface could silently drop a file the author wrote
**Severity:** high
**Description:**
The tool scan was fixed first because that is where a user hit it, but the same
shape existed in five other scanners: a route, script, plugin, middleware or
prompt that failed to import was warned about and skipped, and the warning was
discarded at runtime boot. The agent then ran without a surface that exists on
disk, with nothing anywhere saying so — a 404 for a file sitting in
`server/api/`, `axon run <name>` reporting a script as not found. Middleware was
the worst of them: it commonly carries auth and validation, so a silently
skipped one is a request path running without the checks its author wrote.
**Resolved.** All six load-failure paths now throw
(`ROUTE_LOAD_FAILED`, `SCRIPT_LOAD_FAILED`, `PLUGIN_LOAD_FAILED`,
`MIDDLEWARE_LOAD_FAILED`, `PROMPT_INTROSPECT_FAILED`), naming the file. The
"no default export" cases are left as warnings deliberately — a file in those
directories that exports nothing is not necessarily a broken surface.
**References:**
- libs/axon/platform/src/build/blueprint/scan/{routes,scripts,plugins,middleware,prompts}.ts
- libs/axon/packages/err/src/map.ts — AX-BLUEPRINT-007..011
- libs/axon/platform/tests/integration/blueprint/scan-failures.test.ts

## [x] Scan warnings reached nobody at runtime
**Severity:** medium
**Description:**
`runtime/agent.ts` destructured `{ blueprint }` from both the boot and reload
scans and dropped `warnings` on the floor. The only consumers in the repo were
`apps/tui/cli/agent.ts` (`prepare` and `dev`), so anything a scan warned about
during a boot or a watcher reload was invisible. With load failures now
throwing, what remains is the genuinely graceful set — chiefly shadowing — and
that is exactly what an author needs told: they installed a module whose tool
exists, compiles, bundles, and is nowhere in their agent.
**Resolved.** Warnings are committed to the session log as `axon:scan:warning`
at boot and on every reload.
**References:**
- libs/axon/platform/src/build/runtime/agent.ts — recordWarnings()

## [x] Two tools could claim one callable name, silently
**Severity:** high
**Description:**
`merge()` resolves collisions between TOOL names (the filename), so an agent's
`weather.ts` correctly shadowed a module's `weather.ts`. It cannot see two
differently-named files whose EXPORTS collide: an agent's `weather.ts` and a
module's `forecast.ts` both exporting `now()` are distinct tools by its
reckoning, so both survived. Both then installed flat, so `tool-globals.d.ts`
and the model's `<scope>` each declared `function now()` twice, and the capsule
builds flat globals with `Object.assign` — whichever tool loaded last silently
won and the other export was unreachable. Verified end to end against a real
module on disk.
**Resolved.** `toScope()` now dedupes flat members by callable name with
agent-origin tools winning, the same precedence `merge()` applies one level up.
Deduping is per member, so a module losing one contested name keeps the rest of
its surface.
**References:**
- libs/axon/kernel/src/scope.ts — toScope()
- libs/axon/platform/tests/integration/modules/collisions.test.ts

## [ ] Local staging registry is not seeded, so registry-dependent tests fail on a fresh stack
**Severity:** medium
**Description:**
`runtime/zeno.test.ts` clones `@axon/zeno` from the registry, and platform tests
resolve against local staging (`http://localhost:3099`). Nothing seeds staging,
so on a fresh `arc up` the artifact is absent and all six tests fail with a 404
from `/api/registry/resolve` — a failure that reads as a code regression but is
an empty database. It was published by hand to get the suite green. Any test
depending on a published artifact has the same fragility, and the deploy fixture
had a related one: a git-tracked tarball carrying a prebuilt cognet pinned to a
kernel ABI that had since moved, which failed all 28 cloud deployment tests.
The clean version is a seed step in the staging boot that publishes the registry
artifacts the suites depend on, so the stack is self-sufficient and an ABI bump
cannot leave a stale binary behind.
**References:**
- libs/axon/platform/tests/integration/runtime/zeno.test.ts — clones @axon/zeno
- libs/axon/platform/tests/setup/preload.ts — resolves against localhost:3099
- libs/cloud/tests/fixtures/agent-bundle/source.tar.gz — rebuilt for ABI 10
- libs/repo/src/staging/ — where a seed step would live

## [ ] Staging auth expires silently, and every network test then reads as a code failure
**Severity:** medium
**Description:**
With the staging daemon up and healthy, the fixture credentials in
`tests/setup/user.ts` can still be rejected — the backend answers 401
`AUTH_EXPIRED` to every authenticated call, and ~60 tests across `cloud.*`,
`installer`, `publish` and `registry clone/fork` fail at once. Nothing in the
output says "your token expired": each test reports its own assertion failure,
so the suite looks like a broad regression in whatever was last touched. This
is distinct from the empty-registry item above — the stack is running and
seeded, the credential is simply stale. Diagnosing it currently means curling
the backend by hand to see the 401. The clean version is a preflight in the
test setup that makes one authenticated call and fails the whole run with one
loud message naming the fix, rather than letting every dependent test fail on
its own terms. `arc status` reporting credential validity alongside liveness
would catch it even earlier.
**References:**
- libs/axon/platform/tests/setup/user.ts — TEST_USER fixture keys
- libs/axon/platform/tests/setup/preload.ts — where a preflight would live
- libs/repo/src/staging/ — `arc status` could report token validity

## [ ] The watcher's data/ test is timing-flaky under load
**Severity:** low
**Description:**
`"still fires for changes elsewhere in data/"` waits a fixed `SETTLE_MS` for an
fs notification after writing `data/knowledge/notes.md`. It passes reliably on
its own and fails intermittently when the full suite runs in parallel, because
the notification simply has not arrived inside the window — the assertion is
sound, the deadline is not. A sleep-then-assert is a race whenever the machine
is busy. The clean version polls for the expected path with a generous ceiling
and fails only when it never arrives, so a slow machine costs time rather than
a false negative.
**References:**
- libs/axon/platform/tests/integration/project/agent/watcher.test.ts — SETTLE_MS

## [ ] libs/cloud hardcodes the frame layout it publishes from
**Severity:** medium
**Description:**
`Bundle()` in `libs/cloud/src/registry/artifacts/bundle.ts` locates a project's
package.json and tool surface by walking a fixed number of directory levels up
from the bundle directory. That encodes @arcforge/platform's frame layout in a
package that does not own it, so moving the bundle from `.agent/` into
`.agent/build/` broke every agent publish while the whole suite stayed green —
the only tests covering that path need a live authenticated registry, so they
were already failing for an unrelated reason and the regression hid among them.
The upward search is now two levels and covered by `bundle-layout.test.ts`
(no network, fails in milliseconds), but the coupling remains: platform decides
where a bundle lands and cloud independently guesses how to read it. The clean
version has the publisher pass the resolved paths it already knows, so there is
one authority on the layout instead of two that must agree.
**References:**
- libs/cloud/src/registry/artifacts/bundle.ts — the upward search
- libs/cloud/tests/registry/bundle-layout.test.ts — the regression guard
- libs/axon/platform/src/build/frame/frame.ts — the layout's real owner

## [ ] resolve.test.ts builds a Store with no settings writer, so `agents.watch()` throws
**Severity:** low
**Description:**
Three tests in `tests/unit/resolve.test.ts` fail with `AX-EXT-027 Settings
Cannot Be Written`. The fixture constructs a `Store` without a `setSetting`
callback, and `store.profiles.active()!.agents.watch(path)` requires one to
record the extra scan root — so the call throws before the resolve under test
ever runs. The tests are asserting real behaviour (a watched path is searched,
the profile's own agent wins a name collision); only the harness is
incomplete. The clean version gives the fixture an in-memory settings writer,
so `watch()` records the path the same way it does in a real profile. Not
introduced by any recent change — the failure predates the module-install
audit and was found while running the full suite during it.
**References:**
- libs/axon/platform/tests/unit/resolve.test.ts — the fixture and the three tests
- libs/axon/platform/src/services/store/store.ts — `watch()` / `unwatch()` require `opts.setSetting`

## [ ] An extension update trusts the name, not the publisher
**Severity:** medium
**Description:**
`extensions.update()` moves a pinned entry to whatever the registry now
publishes under that name. Nothing binds the artifact to the identity that
published the version the user originally chose, so if a name changes hands —
transferred, reclaimed after deletion, or an account compromised — an update
pulls a different author's code under a name the user already trusted. That
code runs at module scope on every boot with the full TUI API (keys, commands,
agent control), so the blast radius is the whole terminal. The manual-only
update flow limits this to something the user triggers, which is why this is
medium rather than high, but consent to "update the thing I installed" is not
consent to "run whatever now owns this name". The clean version records the
publisher id alongside the version at install time and refuses an update that
changes it without an explicit override.
**References:**
- libs/axon/platform/src/build/extensions/extensions.ts — `updates()` / `update()`
- libs/axon/platform/src/build/extensions/edit.ts — `addEntry()` pins name@version only

## [ ] The `Axon()` test global is declared and documented but never installed
**Severity:** high
**Description:**
`.agent/types/axon-test.d.ts` declares `const Axon: import("@arcforge/types").AxonTest`
as an ambient global, and the published testing docs teach it as the entire agent-testing
story — "Boot a full Axon runtime for integration testing. Global — no import needed."
Nothing in the repo ever assigns `globalThis.Axon`. `test-preload.ts` installs the
instrumented `bun:test` lifecycle API (`describe`, `it`, hooks) and nothing else, so every
agent test written from the documentation fails at the first line with
`ReferenceError: Axon is not defined`. This is not hypothetical: the checked-in
`registry/agents/dave/tests/boot.test.ts` fails exactly this way today, as does any file a
user writes by following `/docs/v2/agent/tests`. The type asserts a runtime state that does
not exist, which is the failure mode types are supposed to prevent. The clean version
installs the harness onto `globalThis` from the preload — booting the agent's real
`axon.config.ts` rather than the synthetic cognet `libs/axon/core/tests/setup/axon.ts`
injects — so that the declaration, the docs, and the runtime agree.
**References:**
- libs/axon/platform/src/bin/test-preload.ts — installs the bun:test API; never assigns Axon
- libs/axon/platform/src/build/project/typegen/axon-dts.ts:308 — emits the global declaration
- libs/axon/types/src/define.ts:287 — `AxonTest` type with no implementation behind it
- registry/agents/dave/tests/boot.test.ts — checked-in test that fails on this
- apps/axon.arclabs.it/content/docs/v2/agent/tests/index.md — documents the global

## [ ] AxonKernelEvent does not admit the events kernelLog actually holds
**Severity:** medium
**Description:**
`isKernelEvent()` (types/src/session/classify.ts:23) routes `kernel:*`,
`cognet:*` AND `capsule:*` into `session.kernelLog`, but `AxonKernelEvent` is
derived from `AxonKernelEventMap` alone — which contains only the `kernel:*`
family. So the array's declared element type excludes most of what it holds at
runtime, and any consumer that switches on `event.type` for a `capsule:*` or
`cognet:*` case gets TS2678 ("not comparable") followed by `never` on every
field access. The workaround at each call site is a structural re-declaration
of the envelope or an `as` cast, which is how a type lie propagates. The clean
version derives AxonKernelEvent from the same predicate that classifies into
the log — `AxonKernelEventMap & CognetEventMap & CapsuleEventMap` minus the two
`capsule:attach`/`capsule:detach` exceptions classify.ts already carves out —
so the type and the runtime agree by construction. Not fixed here because
widening it touches every kernelLog consumer.
**References:**
- libs/axon/types/src/session/session.ts:67 — `AxonKernelEvent` derivation
- libs/axon/types/src/session/classify.ts:23 — `isKernelEvent` (the real rule)
- libs/axon/platform/src/procs/tree.ts — `ProcLogEvent`, a structural workaround

## [x] Socket short writes silently dropped data
**Severity:** critical
**Description:**
`Bun`'s `socket.write()` returns how many bytes the kernel ACCEPTED, which goes
short once the send buffer fills (~233KB measured on this host). The first cut
of `link/socket.ts` ignored that return value, so every byte past the buffer was
discarded with no error anywhere — 500 rapid `send()`s arrived as 278, and a
frame truncated mid-payload desynchronises the stream so that every subsequent
length prefix is read at the wrong offset. Fixed by `Writer`, which queues the
unwritten tail and flushes it on the socket's `drain` event. A second, related
defect surfaced immediately after: the queue made short writes safe but absorbed
backpressure into memory, so a stalled consumer became unbounded growth instead
of a stalled producer. `ChannelSocket` now exposes `pending`/`whenDrained` and a
stream producer parks above a high-water mark, which is what actually reaches
back to the thing generating tokens.
**References:**
- libs/axon/platform/src/link/socket.ts — Writer, the drain queue, whenDrained
- libs/axon/platform/src/link/channel.ts — STREAM_HIGH_WATER, the producer park
- libs/axon/platform/tests/integration/link/socket.test.ts — both regressions pinned

## [ ] Stale link socket directories accumulate on failed spawns
**Severity:** low
**Description:**
`prepare()` removes and recreates its own directory under
`~/.axon/cache/link/<sessionId>/`, so a reused session is clean. But a spawn
that fails before `dispose()` — a boot failure, a killed supervisor — leaves
its directory behind forever. 45 were observed after a few minutes of ordinary
use during the agent-process migration. Each is ~4KB of empty sockets, so the
cost is clutter rather than capacity, but it grows without bound and makes the
directory useless for answering "what is running". The clean version sweeps
entries whose session is not in `running/` at startup, the way `Running()`
already GCs dead records — self-healing on whichever process looks next,
rather than a cleanup path that itself has to be reached.
**References:**
- libs/axon/platform/src/link/spawn.ts — prepare(), socketRoot()
- libs/axon/platform/src/services/running/running.ts — the GC pattern to copy

## [ ] Boot-stage tracing left in the agent entrypoint
**Severity:** low
**Description:**
`agent-main.ts` carries a `trace()` helper gated on `AXON_TRACE_BOOT`, added to
diagnose an agent that connected but never reported. It earned its keep — it is
what located the boot hang — and it costs nothing unset. But it is diagnostic
scaffolding rather than product code, and the stages it names (`start`,
`connected`, `axon-booted`, `ready`) will drift from the real sequence the
moment boot changes. Either promote it to a real span family committed through
the session, or delete it once the confined boot path has been stable for a
release.
**References:**
- libs/axon/platform/src/link/agent-main.ts — trace(), four call sites

## [ ] `capsule:*` → `process:*` compatibility arms
**Severity:** low
**Description:**
Five read sites accept BOTH prefixes so session logs written before the rename
stay readable — the flame graph, the process tree, `classifyEvent`, and two
Fleet folds. That was the right call at the time (a rename that silently made
historical sessions render as empty timelines is worse than a compat branch),
but the arms are dead weight the moment no log anyone cares about predates the
rename. Delete them together, not one at a time: a partial removal means some
readers understand an old log and others do not, which is harder to reason
about than either end state.
**References:**
- libs/axon/types/src/session/classify.ts — isKernelEvent
- apps/tui/app/composables/useAgents.ts — two sites
- apps/fleet/webview/src/components/capsule/toCapsuleModel.ts
- apps/fleet/src/platform/agent/session.ts

## [ ] Test suite still reaches for in-heap organs on linked agents
**Severity:** medium
**Description:**
`agents.spawn()` now produces LINKED agents (a real process behind the six
verbs), so `agent.current.axon` and `agent.current.kernel` are correctly
absent — there is no in-heap runtime to hand out. Roughly 12 test sites still
reach for them and fail with "null is not an object". The mechanical half is
done: `blueprint` and `session` reads were migrated to the source-agnostic
`agents.blueprint` / `agents.session`, and `Runtime.current` now returns both
agent kinds (it was filtering to `process`, which made it null for every agent
the platform spawns). What remains needs a decision per site rather than a
rename: a test wanting `axon.request()` should drive the link's `request` verb,
and one wanting `kernel.run()` should use `link.run`. Roughly 28 platform
failures trace here.
**References:**
- libs/axon/platform/tests/integration/tools/ — adversarial-runtime, runtime
- libs/axon/platform/tests/integration/modules/lifecycle.test.ts
- libs/axon/platform/tests/integration/runtime/ — spawn, reload

## [ ] A full tree cache grafts an empty node_modules and reports success
**Severity:** critical
**Description:**
With `~/.axon/cache/trees` at DEFAULT_MAX_TREES (24), a prepare grafted a
`node_modules/@axon/` directory that was EMPTY, and reported success — `prepare` returned
with no error and no failed install, so nothing downstream knew the tree was hollow. The
next thing to read node_modules (`resolveCognet`) then threw COGNET_NOT_FOUND naming a
config that was correct all along, which sends the reader to check their specifier, their
registry, and their spelling — none of which is the problem. `rm -rf ~/.axon/cache/trees`
fixes it instantly, which is the tell.
Reproduced on a freshly scaffolded agent: `axon init t3 && rm -rf node_modules bun.lock &&
axon prepare` failed until the cache was cleared, then succeeded. treecache.ts's own
docstring already names this class of bug ("eviction deleted a tree a live project was
grafted onto, and every package in that project went dangling at once") — this is the
same failure reached through eviction pressure rather than manual deletion.
The graft must VERIFY what it linked: a cache hit that produces no packages is a miss, and
should fall through to a real install rather than being trusted. A cheap check (does the
grafted tree contain the packages the manifest declares) turns a silent hollow install into
an ordinary slow one.
**References:**
- libs/axon/platform/src/build/project/treecache.ts — graft, eviction, DEFAULT_MAX_TREES
- libs/axon/platform/src/build/project/tree.ts — install(), where the graft is trusted
- libs/axon/platform/src/build/blueprint/cognet/resolve.ts — where the hollow tree surfaces

## [ ] A cognet imported from outside the project root ships an unresolvable config
**Severity:** high
**Description:**
An agent may name its cognet by importing it (`import Cognet from "../../cognets/zero/cognet.config"`).
Locally that resolves; on deploy it does not. `bundle/agent.ts` copies the project root
verbatim — `axon.config.ts` included, import line intact — while the brain itself is
replaced by a COMPILED artifact staged at `.agent/cognet/`. So the shipped config imports
a path that was deliberately not shipped, and the container dies at boot with
`CONFIG_LOAD_FAILED: Cannot find module '../../cognets/zero/cognet.config'` — after
provisioning has already been paid for. `registry/agents/barry.mk3` reproduces it.
The failure is also invisible until the cloud: `axon build` succeeds, and nothing checks
that the config's imports resolve inside the tarball. The fix is either to rewrite the
`cognet:` import at stage time to the compiled path the manifest already declares, or to
refuse at bundle time with a named error — but not to let it reach a running container.
**References:**
- libs/axon/platform/src/build/project/bundle/agent.ts — copyTree(), stageCognet()
- libs/axon/platform/src/build/blueprint/scan/config.ts — where the container's load fails
- registry/agents/barry.mk3/axon.config.ts — the reproducing case

## [ ] `models:` weights are fetched but unreachable — acquisition without delivery
**Severity:** high
**Description:**
`axon prepare` still reads a cognet's `models:` map, fetches every weight, verifies it and
caches it machine-wide, and `Blueprint()` resolves the paths — but `AxonBlueprint` declares
no `models` field, `CognetConfig` no longer declares the key, and `KernelAbi` has no
`models` verb. The delivery half was removed and the acquisition half was left running, so
a cognet that declares weights downloads them and then has no way to reach them. The
blueprint comment at blueprint.ts:188 names the exact failure mode ("a brain that declared
models and received none is broken in a way that only shows up at first inference") and
proceeds regardless — a silent failure the code already predicted. Either the feature was
deliberately superseded by `engines:` (a `stream`/`transform` role covers the VAD/ASR case
`models:` was written for), in which case `readCognetModels`, `resolveDeclaredModels`,
`Models()`, `parseModels` and `ModelRef` should all come out and `prepare` should stop
fetching; or the ABI verb needs restoring. It cannot stay in between. Docs were corrected
to stop advertising `kernel.models`, which was the only thing telling authors to use it.
**References:**
- libs/axon/platform/src/build/blueprint/blueprint.ts — 188, 251-267 resolveDeclaredModels
- libs/axon/platform/src/build/blueprint/cognet/abi.ts — 105 readCognetModels
- libs/axon/platform/src/build/project/models/ — Models(), parseModels, fetchModel
- libs/axon/platform/src/build/project/prepare.ts — 131, 614
- libs/axon/types/src/cognet/cognet.ts — 119 ModelRef, orphaned
- libs/axon/types/src/kernel/abi.ts — KernelAbi has no models verb

## [ ] Agent run can hang after the engine returns, with the tick/drain spans never closing
**Severity:** high
**Description:**
Observed once and not reproduced: `axon @cody/barry.mk3 -s a` completed the model call but
never exited. The trace showed `kernel:engine` as the only CLOSED span, while `session`,
`kernel:run`, `cognet:tick 1`, `cognet:phase:invoke` and `cognet:system:drain` all remained
open — so the engine returned and nothing above it unwound. `cognet:system:drain` staying
open is the most suspicious of these: a drain that never completes plausibly blocks the tick
above it from closing, which blocks the run, which holds the process alive. A subsequent run
of the same script exited cleanly and printed `axon:agent:done`, so this is intermittent
rather than a hard break — which makes it more dangerous, not less, since a deployed agent
that hangs after billing for inference is the worst version of this. Needs the completion
path between the engine returning and tick/run closing read properly, with attention to
whether drain can be left waiting on something that already finished.
**References:**
- libs/axon/platform/src/build/runtime/ — the run/tick unwind
- trace signature to match: kernel:engine closed, cognet:system:drain still open

## [ ] `agents.find()` reads package.json on every candidate, on every lookup
**Severity:** low
**Description:**
Agent identity now comes from each candidate's package.json rather than its directory name,
which is what makes `@cody/barry` and `@alice/barry` distinguishable. The cost is a
synchronous read + JSON.parse per agent directory per lookup, and `find()` scans every pool
rather than stopping at the first hit (deliberately — it has to detect ambiguity). With a
handful of agents this is invisible; a user watching a directory of fifty would feel it on
every resolution. If it ever matters, the fix is a per-process cache keyed by directory
mtime, not a return to directory-name matching.
**References:**
- libs/axon/platform/src/services/store/store.ts — identity(), find(), list()

## [ ] In-process agent boot bypasses confinement entirely
**Severity:** critical
**Description:**
`Agent()` treats `confined` as OPTIONAL (`agent.ts:412`); absent, it boots `Axon()` directly
in the caller's heap and returns `kind: "process"`. Only `instances.ts:274` passes `confined`,
so `axon run`, `axon dev`, `axon <ref> -s <script>` and `-p` all run agent code — including
every tool and every model-emitted `<typescript>` block — inside the CLI process with no OS
box around it. Policy cannot be enforced on a process that IS the enforcer, so this is a hole
in the user policy contract, not merely dead code. It also silently disables tools: `Axon.ts:167`
gates tool loading on `opts.remote` (which means "inference crosses the link", an unrelated
fact), and the in-process path passes neither `remote` nor `confined` — so a script run this
way sees zero tools and fails with "fs is not defined" for a module its config plainly installs.
The clean version: `confined` is required, `boot()`/`kind: "process"`/`current`/`serve()` are
deleted, `AgentT` collapses to the linked shape, and tool loading stops being conditional
because the agent's own heap is the only place tools can live.
**References:**
- libs/axon/platform/src/build/runtime/agent.ts — 80 (optional `confined`), 412 (the fork), 486-506 (`boot()`), 660-700 (`kind: "process"`, `current`, `serve`), 824 (`isProcessAgent`)
- libs/axon/core/src/Axon.ts — 167, the `remote` gate on tool loading
- apps/tui/cli/agent.ts — 19-27 (`ProcessAgent`/`inProcess`), 336 (`axon dev`), 481 (`axon run`/`-s`)

## [x] `axon -p` prints nothing — bus output never reaches the CLI subscription
**Severity:** high
**Description:**
`axon <ref> -p "..."` runs the turn and the model answers — the session log holds the
`cognet:output:text` entries with correct string content — but the CLI's
`local.bus.onAny(...)` subscription never sees them, so the command prints nothing and
exits silently. The subscription is taken on the supervisor-side `LinkedRuntime.bus`,
which is documented as the place a linked agent's commits fan out; either the commits are
not reaching that bus, or the subscription is registered after the wake has already
streamed. Was masked until now: the handler used to throw ERR_STREAM_NULL_VALUES on the
first empty delta (fixed — the payload is narrowed rather than cast), and the throw was
the only visible sign the path ran at all.
**References:**
- apps/tui/cli/agent.ts — the `-p` path, `local.bus.onAny` subscription
- libs/axon/platform/src/build/runtime/agent.ts — `LinkedRuntime.bus`

**Resolved:** the subscription was fine; the payload shape was not. `bus.forward()` emits `(entry.type, entry)` — the whole ENVELOPE — so the text sits at `payload.data.content`, and the handler was reading `payload.content` and finding undefined every time. Narrowed rather than cast, and empty deltas are skipped rather than written (which is what threw ERR_STREAM_NULL_VALUES).

## [ ] Every session event is committed twice
**Severity:** medium
**Description:**
Reading any recent session log shows each entry duplicated — `cognet:output:text` twice per
delta, `axon:agent:done` twice, `axon:shutdown:start`/`:complete` twice, `axon:session:closed`
three times. Both copies carry identical data, so this is a double-commit rather than two
distinct events. Doubles the log on disk, and any consumer counting entries (token
accounting, timeline rendering, `hasEntries`) is reading inflated numbers. Suspect two
writers attached to the same session — the supervisor's recorder handover
(`recorder.handOver` in agent.ts) is the obvious candidate.
**References:**
- libs/axon/platform/src/build/runtime/agent.ts — recorder.handOver
- libs/axon/packages/session/src/session.ts — commitEntry

## [x] Extension version resolution sorts lexically, not by semver
**Resolved:** `versions()` now orders by semver (newest first) via the `semver` package already
used by services/update, drops non-semver directories, and `config.registryRoot()` reads
position 0 rather than re-deriving the rule. `updates().outdated` uses `gt()` with `valid()`
guards on both sides, so a downgrade is no longer offered as an update. Fixtures re-cut with
0.10.0 so the rule is pinned rather than the example.
**Severity:** high
**Description:**
`ExtensionStore.versions()` sorts with `.sort()`, so `0.10.0` orders before `0.9.0` and an
unpinned entry resolves to the OLDER version. Verified: with 0.2.0, 0.9.0 and 0.10.0 present,
`resolve("@cody/theme")` returns 0.9.0. The same lexical rule is written a second time in
`config.ts:registryRoot()`, so the two can drift independently. Separately,
`Extensions.updates()` computes `outdated` as `latest !== version` — a string inequality, so
a registry that serves an older version reports the user as out of date and offers a
"update" that is a downgrade. The clean version is one shared semver comparator used by all
three sites, with prerelease handling stated explicitly.
**References:**
- src/build/extensions/store.ts — `versions()`, `resolve()`
- src/build/extensions/config.ts — `registryRoot()`, duplicate of the same rule
- src/build/extensions/extensions.ts — `updates()`, `outdated` via `!==`

## [x] Publish does not verify that an extension loads
**Resolved:** `extension` added to `COMPILES`; `verifyExtensionLoads()` runs the consumer's own
`loadSource` against the extracted tarball with stubbed TUI globals. An extension importing a
file it did not ship, or throwing at module scope, is now refused at publish.
**Severity:** high
**Description:**
`verifyArtifact` compiles only `cognet` and `module` (`COMPILES`), so `extension` publishes
with no check that its source resolves. An extension is source the consumer compiles and
imports — exactly the failure class this function exists for, and the one that already
shipped twice for modules (@axon/arxiv). An extension whose `main.ts` imports a sibling it
forgot to ship publishes cleanly and fails on every consumer's install, with the author's
only signal being someone else's terminal. Verified: such an extension loads to
`Cannot find module './not-shipped'`. Fix is to add `extension` to COMPILES and verify by
loading the extracted tarball the way the TUI would.
**References:**
- src/build/project/publish/verify.ts — `COMPILES`
- src/build/project/kinds.ts:274 — the extension kind, `bundle: "source"`

## [x] No timeout or budget on extension load
**Resolved:** `LOAD_BUDGET_MS` (10s) per file, reported as `EXTENSION_LOAD_TIMEOUT` (AX-EXT-034).
Bounds how long a hung file delays boot; it does NOT claim to cancel the file, because JS
cannot interrupt synchronous code — the error says loading continued without it. Rescues the
common shape (an await that never resolves).
**Severity:** medium
**Description:**
`loadSource` awaits each file's import with no time limit, so an extension with a blocking
top-level loop stalls TUI boot indefinitely with no diagnostic — measured 300ms for a trivial
spin, unbounded in principle. Nothing prevents an extension calling `process.exit()` either.
Per-file containment covers a file that THROWS but not one that never returns. A published
extension is third-party code running in the user's terminal process; a budget plus a named
error ("X took longer than Ns to load") turns a hang into a report.
**References:**
- src/build/extensions/load.ts — `loadSource`, `importFile`

## [ ] The agent's server surface is silently dropped crossing the process boundary
**Severity:** critical
**Description:**
`confined.ts:94` writes the blueprint to the agent as `JSON.stringify(opts.blueprint)`, and
`agent-main.ts:45` reads it back with `JSON.parse`. Every FUNCTION in it is lost in that
round trip — `AxonRoute.handler`, `AxonMiddleware.handler`, and `AxonPlugin.fn` are all
dropped. The entries survive with their metadata, so nothing looks wrong: `Routes()` mounts
a route whose handler is `undefined`, h3 registers it, and the request 404s with no warning
in the log and no scan warning either. Confirmed by round-tripping a real blueprint: a
route enters as `{method, path, file, handler}` and arrives as `{method, path, file}`.

Routes 404ing is the visible half. The dangerous half is MIDDLEWARE: `AxonMiddleware`'s own
doc says a dropped middleware is "a request path running without the checks its author wrote
— a security hole that looks like a working server", and describes failing closed as the
correct posture. That failure mode is live right now for every confined agent, which is
every agent.

Routes can be re-resolved agent-side — `AxonRoute.file` exists for exactly this. Middleware
and plugins carry no file path, so they cannot be, and the fix is wider than one import:
either every entry carries its source and the agent re-imports the set, or the agent scans
its own `server/` rather than receiving it. The type docs still say "resolved by the CLI,
mounted as-is by the runtime", which was true before the agent became its own process.

Note `/_axon/*` endpoints are unaffected (constructed in-process) and work — health returns
200 and the SSE stream serves — so the server itself is healthy. It is only the AUTHORED
surface that vanishes.
**References:**
- libs/axon/platform/src/link/confined.ts — 94, JSON.stringify of the blueprint
- libs/axon/platform/src/link/agent-main.ts — 45, JSON.parse on the far side
- libs/axon/types/src/route.ts — `handler`, and `file` which makes routes recoverable
- libs/axon/types/src/middleware.ts — the fail-closed doc this violates
- libs/axon/types/src/plugin.ts — `fn`, no file path
- libs/axon/core/src/runtime/server/routes.ts — mountRoute, mounting undefined

## [ ] A synchronous infinite loop in a config file still hangs boot
**Severity:** medium
**Description:**
The load budget bounds an await that never resolves, which is the common shape, but a
synchronous `while (true) {}` at module scope owns the thread and no timer fires — the
terminal never boots and nothing can report why. Containing this needs the load to run
somewhere interruptible (a Worker, or a subprocess) rather than on the main thread, which is
a real design change and should not be smuggled in as a timeout. Worth doing before
third-party extensions are common; a published extension is untrusted code in the user's
terminal process.
**References:**
- src/build/extensions/load.ts — `withBudget`, `LOAD_BUDGET_MS`

## [x] Declared `paths` were invisible until someone remembered to prime the cache
**Severity:** high
**Description:**
`settingsCache` started as `{}`, so every synchronous read of `extraRoots()`
before a `refreshSettings()` call answered "no watched roots" with total
confidence — unread and empty were the same observable state. This shipped the
same bug three times: the CLI dispatched with a cold cache, then the TUI
booted with one, and both were patched by adding a priming call at that entry
point. The third slipped through because priming gates only what the caller
remembered to put behind it: the TUI primes before the initial agent boot, but
the `^` session palette reads `agents.sessions()` on a path that never waited,
so it listed "no past sessions" for an agent with 563 on disk. Fixed
structurally instead of with a fourth call site — the cache now fills itself on
first read via `readSettingsSync` (one AST read, no evaluation, no lock, same
mechanism `readPolicy` already relied on for exactly this reason), and `null`
now distinguishes unread from empty.
**References:**
- libs/axon/platform/src/platform.ts — the lazy `settings()` reader
- libs/axon/platform/src/build/extensions/edit.ts — readSettingsSync
- libs/axon/platform/tests/unit/settings-lazy.test.ts — the behavioural guard

## [ ] Structural (grep-based) tests guard behaviour they cannot see
**Severity:** medium
**Description:**
`apps/tui/tests/unit/cli/priming.test.ts` asserted that the string
`refreshSettings()` appears in two source files, as the guard against watched
roots going invisible. It stayed green while the bug shipped a third time,
because a grep proves a call exists and cannot prove which reads it gates. The
file itself named this limitation ("the kind of omission a behavioural test
catches only if it happens to construct the whole entry point") and chose the
grep anyway. It has been rewritten to point at the behavioural test that now
carries the weight, but the pattern is worth auditing for elsewhere: a
structural assertion about a dynamic property is a test that reports safety it
cannot verify.
**References:**
- apps/tui/tests/unit/cli/priming.test.ts

## [x] `^` filtered sessions by folder name against a manifest identity
**Severity:** high
**Description:**
The session palette compared a folder name derived from `home` against
`record.agent`, which holds the agent's IDENTITY (package.json's name). For a
scoped agent those never matched, so `^` listed "no past sessions" for an agent
with 216 of them on disk — silently, because an empty list is exactly what a
genuinely new agent looks like. Agents with no readable manifest fall back to
their directory name and kept matching, which made the breakage look
intermittent rather than total. This was the SECOND wrong spelling of the same
comparison: it originally compared `displayName` to a directory name, and the
"fix" derived the folder from `home` just as records switched to identity. Now
both sides read the same field — `displayName` is `project.name`, `record.agent`
is `agent.name` — so there is nothing to keep in step. package.json's name is
the one true name for an agent.
**References:**
- apps/tui/app/composables/palette/definitions/session.ts — the filter
- libs/axon/platform/src/build/runtime/sessions/record.ts — SessionRecord.agent, documented
- libs/axon/platform/tests/unit/sessions-identity.test.ts — what the record holds
- apps/tui/tests/unit/palette/session-identity.test.ts — what the palette compares

## [x] Two call sites opened a session log two different ways, one of them wrong
**Severity:** medium
**Description:**
Clicking the session id in the header called `open()` from the `open` package —
the OS default handler, which opens a `.jsonl` in whatever is registered for
that extension (a notepad), never the editor the user is working in. Meanwhile
`:session open` routed through the attached-editor channel and refused outright
without one, so a user not running Fleet could not open a log at all. Both now
call `useControl().openFile`, one verb with one ladder: attached editor (routed
by the agent's directory), then `$EDITOR`/`$VISUAL`, then refuse. There is
deliberately no OS-handler rung — opening the wrong application is worse than
reporting nothing happened, because it looks like it worked. The `open` package
remains for URLs, which is what it is for.
**References:**
- apps/tui/app/composables/services/useControl.ts — openFile
- apps/tui/app/components/axon-header.vue — the session-id click
- apps/tui/tests/unit/editor-open.test.ts

## [x] A profile policy edit did not re-bound running agents
**Severity:** critical
**Description:**
`profile.config.ts` carries a machine-wide policy CEILING, resolved when an
agent's blueprint is scanned. Saving it reloaded the config and refreshed the
settings cache but told no running agent, so the ceiling was only ever re-read
on a rescan that nothing triggered. A user who tightened their policy
mid-session saw every surface render the policy they had just written while the
capsule went on enforcing the one from boot — `shell.allow` commented out, the
TUI reloaded, and the agent kept spawning processes. This is the worst shape a
policy bug can take: the system READS as enforced while granting everything,
which is strictly worse than having no ceiling at all, and it is the exact
failure the ceiling suite's own header warns about arriving through a door
nobody was watching. Fixed by `useAgents().reloadAll()` — every running
instance, not just the focused one, since the ceiling bounds them all — awaited
from `useExtensions.reload()` so the terminal cannot accept another message
before the re-bound lands.
**References:**
- apps/tui/app/composables/useAgents.ts — reloadAll
- apps/tui/app/composables/extensions/useExtensions.ts — reload
- apps/tui/tests/unit/policy-reload.test.ts
- libs/axon/core/tests/integration/kernel/reload/policy.test.ts
- libs/axon/platform/tests/unit/project/profile-policy-reload.test.ts

## [ ] Three-layer guarantees are tested one layer at a time
**Severity:** medium
**Description:**
The policy-ceiling bug needed three things to hold — the ceiling is re-read
from disk, a reload re-applies it to the capsule, and a config save triggers
that reload — and two of the three were well covered while the third had no
test at all. Both existing suites passed throughout, because each was correct
about its own layer: a correct re-read handed to nobody, and a correct re-apply
of a value nothing refreshed. The same shape produced the settings-priming bug
(the read was right, nothing called it) and the spawn-lifetime bug (the process
was fine, the reporting was not). Worth a deliberate pass over the other
multi-layer invariants — escalation delivery, credential refresh, deployment
promotion — asking not "is each layer tested" but "is the SEAM between them".
**References:**
- libs/axon/core/tests/integration/kernel/policy/ceiling.test.ts — layer 2, always passed
- libs/axon/platform/tests/unit/project/profile-policy.test.ts — layer 1, always passed


## [x] `engine:` warned instead of refusing, so mock fixtures made real billed calls
**Severity:** critical
**Description:**
`engine:` was removed from the config surface but kept loading with a warning,
on the reasoning that such an agent already booted on the profile pool so
refusing would break working agents over an ignored field. That had the cost
backwards: "boots on the profile pool" means the agent runs on a DIFFERENT,
BILLED provider than its config names. Fourteen test fixtures across axond and
platform declared `engine: Mock()` — asking explicitly for offline inference —
and every one silently resolved against the user's real OpenRouter credentials,
which `withAgent()` seeds deliberately so inference works over the link. They
spent real money on every suite run until the account drained, and the only
signal was a warning nobody reads in a test process. The `engine?: never` type
guard could not catch it because these configs are written as strings to disk at
runtime, never typechecked. RESOLVED: the load now throws CONFIG_ENGINE_DEPRECATED
(severity fatal), every fixture uses `providers: [Mock()], model: "mock:mock"`,
and the docs that taught the old form are updated.
**References:**
- libs/axon/platform/src/build/blueprint/blueprint.ts — the warn-and-continue, now a throw
- libs/axon/packages/err/src/map.ts — CONFIG_ENGINE_DEPRECATED, degraded → fatal
- libs/axon/platform/tests/unit/config-engine-deprecated.test.ts — rewritten to assert refusal
- libs/axon/packages/axond/tests/integration/agents/*.test.ts — 11 fixtures
- libs/axon/platform/tests/integration/{modules,blueprint}/*.test.ts — 3 fixtures

## [x] Integration fixtures can reach real providers, with nothing preventing it
**Severity:** high
**Description:**
The `engine:` incident was one instance of a general hole: `withAgent()` seeds a
profile carrying real credentials so inference resolves over the link, and any
fixture whose declared inference fails to bind falls through to that pool rather
than failing. A test that means to be offline has no way to assert it, and the
failure is silent and billed. The clean version is a test-mode guard that refuses
any non-mock provider resolution when a fixture asked for a mock — or, more
simply, an env flag the test preload sets that makes real provider construction
throw, so reaching the network in a unit/integration run is a hard error rather
than an invoice. RESOLVED: `AXON_NO_NETWORK_INFERENCE` is set by both test
preloads and enforced in `buildProvider()` — the seam every boot path converges
on — as an ALLOWLIST of mock/ollama, so a BYOK route added to DIRECT_PROVIDERS
later is refused offline by default rather than by someone remembering. Verified
by reintroducing the original bug (a fixture declaring no working provider): it
now fails loudly naming the fix, where before it billed silently.

Turning the guard on found FIFTY-FOUR more billed tests than the `engine:`
fixtures accounted for, from two further causes. A scaffolded agent is
`defineAgent({})` — it declares no inference at all, deliberately, because that
is what `axon init` writes — so it resolves entirely against the PROFILE pool,
whose default (`providerPool`'s DEFAULT_PROVIDERS) is the metered `axon` route.
No per-fixture edit could reach those. And several suites spawn through a bare
`supervised()` with nobody logged in, where `profileProviders()` returns
undefined and the pool defaults to metered again. Fixed by seeding
`profile.config.ts` with `providers: [Mock()]` from `supervised()` itself, and
by moving spawn-then-wake suites onto `authenticated()`. Final state: 158 pass,
0 fail, all offline.
**References:**
- libs/axon/packages/engines/src/providers/providers.ts — buildProvider(), OFFLINE_PROVIDERS
- libs/axon/packages/engines/src/providers/pool.ts — DEFAULT_PROVIDERS, the metered default
- libs/axon/packages/axond/tests/setup/preload.ts — sets the flag
- libs/axon/platform/tests/setup/preload.ts — sets the flag
- libs/axon/packages/axond/tests/setup/supervised.ts — seeds the mock profile

## [ ] Six axond suites hand-roll the same profile login
**Severity:** medium
**Description:**
`authenticated()` in tests/setup/supervised.ts exists to build a platform with
TEST_USER logged in, and six integration files each carry their own copy of that
block instead — eight call sites of the same four lines. That duplication is why
the billing hole stayed invisible: there was no single place where "a seeded
profile means metered inference" could be noticed, and each copy had to be found
and fixed separately when it was. Several are now pointed at the shared helper;
the remaining local `login()` / `seed` blocks should collapse into it, leaving
`supervised()` for the one case that genuinely wants no active profile (spawn's
NOT_AUTHENTICATED test, which is commented as such).
**References:**
- libs/axon/packages/axond/tests/integration/agents/sessions.test.ts — local login()
- libs/axon/packages/axond/tests/integration/agents/tools.test.ts
- libs/axon/packages/axond/tests/integration/agents/tools-adversarial.test.ts
- libs/axon/packages/axond/tests/integration/agents/lifecycle.test.ts
- libs/axon/packages/axond/tests/integration/agents/reload.test.ts — withAgent()
- libs/axon/packages/axond/tests/setup/supervised.ts — authenticated(), the one that should be used

## [ ] Zeno cannot be updated on disk once a user has customised it
**Severity:** medium
**Description:**
Zeno is cloned from `@axon/zeno` on first run and then owned by the user —
editable, and never written to again. That is deliberate (the base-workspace
design it replaced regenerated configs and needed an ownership hash to detect
and refuse user edits), but it means an improvement to zeno reaches only NEW
installs. Everyone who already has it keeps whatever version they cloned,
forever, including any dead config it carried. The `engine:` field is the first
case where that mattered enough to need a mechanical migration; it will not be
the last. The clean version is probably a narrow, declarative migration channel
— a list of field-level transforms the platform applies to any agent on
prepare, of which the `engine:` removal is entry one — rather than either
overwriting user projects or asking them to hand-edit. Worth designing before
the second migration is needed, not during it.
**References:**
- libs/axon/platform/src/build/runtime/zeno.ts — ensure(), clone-once-then-owned
- libs/axon/platform/src/build/project/manifest/engine-migrate.ts — the first transform

## [x] `find` shelled out for workspace resolution — absent on Windows, failed silently
**Severity:** high
**Description:**
`tree.ts` resolved framework packages with `Bun.spawnSync(["find", …])` at two
call sites and read `.stdout` without checking whether the binary ran. `find`
does not exist on Windows, and spawnSync reports a missing binary as EMPTY
STDOUT — which is exactly what a successful search with no matches looks like.
Both sites looped over nothing and returned null, so "this machine has no find"
was indistinguishable from "this workspace has no framework packages": a
developer on a Mac or Windows box linked against the published copy while
believing they were testing their own checkout. Gated behind AXON_WORKSPACE, so
source-checkout development only — which is precisely who it misleads.
RESOLVED: replaced with an in-process directory walk (`manifestsUnder`), which
has no binary to be absent and skips an unreadable directory explicitly.
**References:**
- libs/axon/platform/src/build/project/tree.ts — manifestsUnder()
- libs/axon/platform/tests/unit/ambient-workers.test.ts — guards the regression

## [x] `Running()` had no test isolation, and its prune swept the real store
**Severity:** high
**Description:**
`Running()` reads four well-known store roots baked into a module-level
constant from `homedir()`. That width is correct in production — an observer
must see agents booted by the installed binary and from a source checkout
alike — but it left the service untestable in two directions: a test asserting
"nothing is running" flaked whenever the developer had an agent open, and
`stop()` prunes EVERY root, so a test cleaning up after itself could delete a
live record belonging to a real process. Neither was reachable, because the
roots were frozen at import. RESOLVED: an `isolated` flag narrowing reads AND
prunes to the injected root — the same flag, spelled the same way, that the
daemon's Registry already carried.
**References:**
- libs/axon/platform/src/services/running/running.ts — isolated
- libs/axon/platform/tests/unit/running-isolation.test.ts

## [ ] OS-specific branches remain largely untestable
**Severity:** medium
**Description:**
15 `process.platform` reads across the repo; before this pass ZERO tests
exercised a non-Linux branch. Those paths cannot execute on Linux CI at all, so
they ship unreviewed however thorough the rest of the suite is — and both
failures that prompted this audit (macOS tool loading, Windows install) were in
that class. The pattern that fixes it is naming the OS fact and injecting it:
`hasProcessGroups()` in capsule/procs.ts is now one named seam replacing three
scattered checks, and `killTree` takes it as a parameter so both shapes are
asserted from one box. The remaining sites should follow: `services/mic/capture.ts`
(3 branches, voice silently unavailable), `services/update/installer.ts` (win32
recovery — a failed self-update with no way back), and the duplicated darwin
probe in `resources/hardware.ts` / `axond/machine/hardware.ts`.
**References:**
- libs/axon/packages/capsule/src/process/procs.ts — hasProcessGroups(), the pattern
- libs/axon/packages/capsule/tests/platform-branches.test.ts — both shapes, one machine
- libs/axon/platform/tests/setup/hostile.ts — the harness for env-sensitive paths
