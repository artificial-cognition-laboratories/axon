## [x] Machine.qml is not wired to the daemon
**Resolved 2026-09-01:** `src/Service.qml` runs `axon daemon watch --json` through
`Process` + `SplitParser` and feeds `Machine.apply()`. Reference counted, so the
stream — and the daemon's 2s cadence it holds via `machine.observe()` — runs only
while a surface is open; a 15s `daemon status --json` poll answers liveness the
rest of the time. Exponential backoff to 30s on respawn, and a fourth health
state (`missing`) for a machine with no `axon` at all.
**Severity:** high
**Description:**
Every figure the panel shows is declared and none is read. `axond` already
measures all of it — `MachineState` carries capacity, live usage, a 60-deep
sample ring, and the holds against video memory with the agent that owns each
— but there is no transport here yet. `Quickshell.Io` provides `Socket`,
which is the intended route to the daemon's control socket; `Process` running
`axon daemon …` is the fallback if that contract is not ready to expose. Until
then `connected` is false and the panel says so rather than drawing zeros.
**References:**
- Machine.qml — every property, and `refresh()`
- libs/axon/packages/axond/src/machine/types.ts — the shape to read
- libs/axon/packages/axond/src/control/ — the socket to read it over

## [x] Resource meters, sparklines, and rows are unbuilt
**Resolved 2026-09-01:** `ResourceRow` + `Sparkline` (QtQuick.Shapes), four meters
over live daemon readings, with Axon's share drawn inside the VRAM series and
hidden while it is zero throughout.
**Severity:** medium
**Description:**
The three panel sections are headers with a placeholder each. RESOURCES wants
four meters (GPU, VRAM, RAM, CPU) built on the `LimitRow` pattern from
`omarchy.agents` — a label, a percent, and a Rectangle track and fill — with a
sparkline per meter drawn from `samples[]` using `QtQuick.Shapes`
(`ShapePath` + `PathPolyline`; there is no chart component in `qs.Ui` and no
QtCharts on the system). The VRAM meter is the one that earns the plugin: it
must distinguish the machine's total use from Axon's `held` share, because
"12.4 GB used, 8.1 GB of it yours" is the sentence no other widget in the
registry can write. LOADED and AGENTS are row lists over `holds[]` and
`agents[]`.
**References:**
- TabOverview.qml, TabLoaded.qml, TabAgents.qml — each is a header and a placeholder
- /usr/share/omarchy/shell/plugins/agents/Panel.qml:704 — the LimitRow pattern

## [x] Blocked on three axond measurement gaps
**Resolved 2026-09-01:** AMD video memory reads through sysfs (`mem_info_vram_*`,
`gpu_busy_percent`) with the card chosen once and shared by `Hardware` and
`Probe`; `cpuUtil` is a delta over `/proc/stat` held inside `Probe`, null on the
first reading because a rate needs two; `VramSource` gained `error` beside
`unknown`, with `vramDetail` carrying the reason, so a driver mismatch no longer
reads as "no GPU".
**Severity:** high
**Description:**
The widget cannot be shown to anyone until the daemon measures what it claims
to. AMD and Intel video memory are unread — `hardware.ts` probes `nvidia-smi`
then Apple then gives up, so `vram` is null on a large share of Omarchy
machines and the headline meters render blank. There is no `cpuUtil`, only a
one-minute load average, which does not graph beside three percentages. And
both nvidia probes `catch` every error, so a driver/kernel mismatch — routine
on Arch after an update — is indistinguishable from "no GPU", which is exactly
when the user most needs to be told.
**References:**
- libs/axon/packages/axond/src/machine/hardware.ts — nvidiaCapacity, probe
- libs/axon/packages/axond/src/machine/probe.ts — nvidiaUsage, read
- libs/axon/packages/axond/src/machine/types.ts — MachineUsage, VramSource

## [ ] Not yet a standalone repo
**Severity:** low
**Description:**
`omarchy plugin add` clones a repo root, and this is a subdirectory of the
monorepo. The package root is already the plugin root so no rearranging is
needed, but a mirror or subtree to a public repo is required before anyone can
install it. That repo also needs public releases before the install funnel
works end to end — the published `@arcforge/axon` binary is `#!/usr/bin/env
bun` and Omarchy ships node, not bun.
**References:**
- manifest.json
- apps/axon.arclabs.it/public/install

## [x] The daemon keeps no history of what Axon holds
**Resolved 2026-09-01:** `MachineUsage` is now `MachineReading & { held }`.
`Probe` stays ignorant of residency and produces the reading; `Samples` stamps
our share on at the same instant, which makes the two series structurally
aligned rather than aligned by convention. `Machine.heldSamples` in the plugin
can go once the transport lands.
**Severity:** medium
**Description:**
`MachineUsage` records `vramUsed` for the whole machine but not the bytes Axon
itself holds, so `MachineState.samples` can draw the machine's video-memory
trend and not our share of it. That share is the one number this plugin exists
to show — the VRAM row is built to say "12.4 GB used, 8.1 GB of it yours" — and
right now only the CURRENT value is available, never the trend. The widget
therefore carries `heldSamples` beside `samples`, which is a second history the
daemon should own instead. `held` is already computed per reading; adding it to
`MachineUsage` is one field and it makes the plugin's headline chart honest
rather than half-mocked.
**References:**
- libs/axon/packages/axond/src/machine/types.ts — MachineUsage
- libs/axon/packages/axond/src/machine/probe.ts — read()
- libs/axon/packages/omarchy/Machine.qml — heldSamples, and why it exists

## [x] `models.remove()` needs a store-level delete first
**Resolved 2026-09-01:** `ModelStore.remove()` drops the index entry and unlinks
the hash directory only when no surviving entry references that sha — content
addressing means two specifiers can name one file. Index written before the
unlink, so a crash between them leaves a stale entry `list()` already skips.
`models.remove()` unloads first, then delegates.
**Severity:** medium
**Description:**
Scoped as a small daemon addition; it is not. `ModelStore` in `@arcforge/platform`
exposes `find`, `has`, `resolved`, `list`, `remember` and `put` — and no delete at
all. So removing a cached weight means adding deletion to the store (the file,
and its entry in the content-addressed index) before `models` can expose a verb
for it. Two packages, and the index is the part that has to be right: a file
removed without its index entry reads as cached forever.
**References:**
- libs/axon/platform/src/build/project/models/store.ts — no delete
- libs/axon/packages/axond/src/models/models.ts — where the verb belongs

## [x] No budget is wired at all
**Resolved 2026-09-01:** `machine/budget.ts` persists a declaration under
`~/.axon/budget.json`, read fresh per call so a change takes effect at the next
admission. `machine.budget.current/set`, `axon daemon budget [12GB|clear]`, and
the browser header is the control. Verified reaching admission: 2GB refused
under a 1GB ceiling.
**Severity:** medium
**Description:**
`MachineOpts.budget` is an optional thunk and `Axond()` never passes one, so
`ceiling()` always falls through to measured hardware and `MachineState.budget`
is always null. The setter this needs is therefore not a setter over an existing
value — there is no persistence for it yet. A small leaf in `machine/` owning a
file under `~/.axon` is the cheapest honest home, read fresh per call the way the
existing doc comment already specifies.
**References:**
- libs/axon/packages/axond/src/machine/machine.ts — budget thunk, ceiling()
- libs/axon/packages/axond/src/axond.ts — never passes one

## [ ] True multi-part weights are still refused
**Severity:** medium
**Description:**
`preferred()` now recognises real weight conventions — GGUF, safetensors, any
`.onnx` name — and ranks a whole file over its shards, so most repositories
fetch. What still refuses is a model that genuinely IS several files: Whisper
ships an encoder and a decoder and needs both, silero-vad ships eight. That is
not a picker problem; `ModelRecord.path` is singular and adapters load one
file, so supporting it changes the record's shape and how a cognet asks for a
weight. Left deliberately, because guessing at that shape is worse than
refusing clearly — which is what the row now does.
**References:**
- libs/axon/packages/axond/src/models/catalog.ts — preferred()
- libs/axon/packages/axond/src/models/types.ts — ModelRecord.path

## [ ] Ollama's residents are invisible in Loaded
**Severity:** low
**Description:**
Demoted from the correctness item it was scoped as. `nvidia-smi` and the new
amdgpu sysfs read both report memory Ollama is using, and `admit()` prefers the
driver figure — so the budget is honest on any machine with a readable GPU. What
remains is display: weights Ollama loaded do not appear in the Loaded tab, so
the picture is incomplete rather than wrong. `ollama ps` would fill it.
**References:**
- libs/axon/packages/axond/src/machine/machine.ts — admit(), `usage.vramUsed ?? held`

## [ ] The model cache is unbounded
**Severity:** low
**Description:**
`Catalog` now persists both query results and full repository detail to
`~/.axon/cache/models-catalog.json`, which is what makes a second visit to a
model instant and shares one fetch across the platform, the extension and the
desktop panel. Nothing evicts. A card is tens of kilobytes and someone browsing
for an afternoon will accumulate hundreds, so the file grows without limit. A
cap by total bytes, evicting least-recently-read, is the obvious shape — the
`shape` stamp already gives a safe way to discard everything if the format has
to change again.
**References:**
- libs/axon/packages/axond/src/models/catalog.ts — read/write, details

## [ ] Code highlighting is a token pass, not a grammar
**Severity:** low
**Description:**
`src/highlight.js` scans for comments, strings, numbers, keywords and call
sites across the languages model cards actually contain — python, bash, js,
json, yaml. It knows nothing about scope or semantics, so it will occasionally
colour a word that merely matches. Shiki cannot run in the shell: it resolves
TextMate grammars with an Oniguruma engine compiled to WASM, and Quickshell's
JS engine loads neither npm modules nor WASM.

The real upgrade is doing it daemon-side. The daemon has bun, and repository
detail is already cached on disk, so highlighting would be computed once per
model and served pre-tokenised. The cost is shipping megabytes of TextMate
grammars into the daemon to colour model cards, which is why it is written down
rather than done.
**References:**
- libs/axon/packages/omarchy/src/highlight.js
- libs/axon/packages/axond/src/models/catalog.ts — where a cached pass would live

## [ ] Markdown renders no video
**Severity:** low
**Description:**
Images now render — bounded rather than trusted: decoded at a capped size,
loaded asynchronously so a slow host never blocks a frame, and falling back to
the alt text on failure. Video does not. A card embedding an mp4 shows its alt
text, and `MediaPlayer` in the shell process is a heavier decision than an
`Image` was: it is a decoder, not a fetch.
**References:**
- libs/axon/packages/omarchy/src/markdown.js — inline(), image handling
- libs/axon/packages/omarchy/components/MarkdownView.qml

## [ ] Search returns one page and cannot go deeper
**Severity:** low
**Description:**
`searchHuggingFace` asks for 100 rows and stops. That is a hundred times what
it used to surface — the `filter=onnx` it carried was excluding every GGUF and
safetensors model, which is most of the registry — but Hugging Face holds
hundreds of thousands and there is no way to reach row 101. The API pages by
cursor through Link headers, so "load more" at the foot of the list is the
shape; the rail's counts would need to become "of what is loaded" rather than
"of what exists", which is the part worth thinking about before building it.

Ollama is fetched whole (its library is tens, not thousands) and filtered
locally, so it has no equivalent limit.
**References:**
- libs/axon/packages/axond/src/models/catalog.ts — searchHuggingFace, searchOllama

## [ ] Ollama models have no detail beyond their listing
**Severity:** low
**Description:**
`ollama.com/api/tags` returns a name, a size and a digest — no card, no
description, no download count. So an Ollama detail page shows its library and
size and then says plainly that no card is published, with a link out to
ollama.com. That is honest, and it is thin.

Richer detail would mean scraping `ollama.com/library/<name>`, which is HTML
with no published contract and would break without warning. Worth doing only if
Ollama models become a common destination rather than a corner of the list — at
which point a small, well-bounded parser with a loud failure is the shape, not a
best-effort one that silently degrades.
**References:**
- libs/axon/packages/axond/src/models/models.ts — at(), the ollama branch
- libs/axon/packages/omarchy/views/browser/pages/Detail.qml — the empty-card state

## [ ] A cached model cannot say whether it recognises or synthesises speech
**Severity:** high
**Description:**
`capability: "speech"` covers both automatic-speech-recognition and
text-to-speech, and on a CACHED record nothing separates them: `type` is
`"transform"` for both, `in`/`out` are empty arrays, and `description` (which
carries the pipeline tag for catalogue entries) is null. So the dictation
engine dropdown in Settings lists Kokoro — a synthesis model that cannot
transcribe — beside Whisper, and choosing it would bind a shortcut to a
guaranteed failure. The daemon already resolves this correctly at RUN time:
`transformers.ts: taskFor()` reads the architecture from `config.json` and
refuses synthesis outright. The clean version runs that determination when the
record is built, so every reader gets the same answer the runtime would.
Guessing from the model name in the panel would be a second, worse copy of a
decision the daemon already makes properly. This blocks dictation shipping.
**References:**
- libs/axon/packages/axond/src/models/transformers.ts — taskFor(), the authority
- libs/axon/packages/axond/src/models/catalog.ts — PIPELINE_TAGS, capabilityOf()
- libs/axon/packages/omarchy/views/browser/pages/Settings.qml — speechModels
