# Local models

`Models` composes one machine-wide model store and inference service. The TUI
connects through `AxonDaemon().models`; it does not load a second copy in its own
process. Agents attached to the TUI use that same client for local inference.

The model palette opens `local:` with installed text generation models first,
followed by cached, searchable Hugging Face registry results, with no management
rows. Queries are debounced outside rendering; continuation exposes further pages.
Selecting an available model provisions its runtime, downloads and loads it, then
switches the focused agent. GGUF acquisition prefers Q4_K_M, then Q4_K_S, then the
smallest complete artifact; `:models browse` offers explicit variant selection. The command palette `:models` owns management; `:models browse`
searches Hugging Face by task and executable format, supports continuation, and
opens repository details with GGUF filenames and sizes. `Download` keeps the
agent's current selection and opens management. `Download & use` provisions the
runtime explicitly, waits for the canonical installed identity, loads the model,
and then changes the focused agent. Leaving that action cancels the pending
switch; a daemon-owned download continues until explicitly cancelled.

`:models` shows all installed modalities and transfer outcomes. Chat selection
excludes speech, embeddings, vision, raw tensor graphs and unidentified entries.
Its model actions can identify older entries from publisher metadata, install their
runtime, unload them, cancel/retry downloads, or confirm removal from disk.
The current agent's model cannot be removed through the palette until it switches.
The daemon also refuses removal while inference is queued, active or loading.

Supported chat artifacts are whole GGUF files through llama.cpp and complete
causal-language-model ONNX repositories through transformers.js. Sharded GGUF,
PyTorch/safetensors repositories and encoder-decoder chat are not acquisition
choices. Registry discovery establishes format/task eligibility; successful load
is the final compatibility check before selection.

## Responsibilities

- `inventory`: enumerate disk entries and validate persisted capability metadata.
- `catalog`: cache provider queries and read revision-specific repository manifests.
- `discovery`: present catalogue entries against the machine's memory budget.
- `acquisition`: resolve verified artifacts, maintain transfer outcomes and remove files.
- `residence`: coalesce loads, account for memory and guard unloading/removal.
- `execution`: serialize inference per weight and retain leases until cleanup finishes.
- `generation`: preserve conversation roles and convert runtime callbacks to streams.
- `runtime`: explicitly provision execution packages in Axon-owned environments.
- `activity`: journal lifecycle start/outcome records in `events.jsonl`, without prompts.
- `state`: project inventory, residency and transfers for clients.

The platform streams downloads into temporary files, verifies SHA-256 before
publishing, and writes the index atomically under an interprocess lock. Cancellation
stays `cancelling` until acquisition cleanup finishes. A completed transfer carries
its canonical model identity, including revision and selected GGUF variant.
Conversational inference crosses the Unix socket as NDJSON, with incremental text,
a final response and explicit errors. Disconnecting cancels the native call and
releases its execution lease. Runtime import/load failures propagate; they do not
trigger an implicit installation or turn into empty inventories.

`protocol()` currently returns `7`. The TUI coalesces compatibility checks per
process and automatically replaces an incompatible daemon with the matching Axon
build before acquisition or inference. CLI startup also replaces stale versions.
Transport failures propagate instead of triggering restarts. Restarting stops
agents directly supervised by the replaced daemon.

GGUF inference preserves the complete request history, including assistant-ending and system-tail harness requests; it does not require a final user message.

Daemon HTTP idle expiry is disabled: cold loading, prompt evaluation and gaps between generated tokens are bounded by request cancellation rather than a socket idle timer.

Request messages are complete conversation turns. Each GGUF call starts a new assistant response, even when the last history message is an assistant reply.
