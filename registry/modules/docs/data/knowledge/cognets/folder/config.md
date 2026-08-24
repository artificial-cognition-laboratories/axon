---
title: cognet.config.ts
description: Identity, ABI version, and how the scheduler wakes this brain.
---

# cognet.config.ts

Identity only. Pure data, no logic, no lifecycle. Behaviour lives in `src/main.ts`, and
the compile step composes the two.

```ts
export default defineCognet({
    name: "zero",
    version: "0.1.0",
    abi: "10",

    mode: { kind: "invocation" },

    // runaway guard: a wake that hasn't converged in this many
    // render→infer→act ticks is a loop bug or a stuck model, not progress
    maxTicksPerWake: 32,
})
```

## Fields

| Field | Required | What it declares |
|---|---|---|
| `name` | yes | The cognet's own name. Its private store is namespaced by this. |
| `version` | yes | Artifact version. |
| `abi` | yes | The kernel ABI this cognet was built against. |
| `mode` | yes | How the scheduler wakes it. |
| `wakeOn` | no | Default wake mask. Absent means wake on everything. |
| `maxTicksPerWake` | no | Hard safety bound for one wake. Defaults to 8. |
| `models` | no | Model weights this brain needs. Fetched, verified and cached by Axon. |

## `abi` — the compatibility contract

```ts
abi: "10"
```

A cognet is versioned against the kernel the way a binary is versioned against syscalls.
This declares which contract it was written for.

`axon prepare` checks it against the kernel the installed Axon provides and fails there,
naming both versions and the file to edit. A cognet built for an older ABI never
half-loads.

This matters more now that cognets version independently of the CLI: an agent can pin
`@you/my-cognet@0.1.0` while its Axon moves forward. The check is what turns that from a
mysterious runtime failure into a clear prepare-time one.

## `mode` — invocation or continuous

Part of the cognet's own declared identity, deliberately **not** blueprint-overridable.
Same trust direction as `abi`: a cognet written for stimulus-driven wakes was never
written to tolerate an empty-stimuli tick, so an agent author can't flip it from outside.

**Invocation** — woken once per admitted stimulus arrival, handed the full diff
accumulated since the last wake. If several stimuli arrived while the previous wake was
running, they arrive together.

```ts
mode: { kind: "invocation" }
```

**Continuous** — woken on the brain's own rhythm, regardless of whether anything arrived.
An empty diff is the ordinary steady state, not an edge case.

```ts
mode: { kind: "continuous" }
```

No rate here on purpose: this declares the cognet's shape ("wake me, don't hand me a chat
prompt"), not its frequency. The brain sets its own rate from a plugin calling
`kernel.wake()` — see [The Loop](/docs/v2/cognets/engine/loop).

## `wakeOn` — the wake mask

```ts
wakeOn: ["cognet:stimulus:text", "cognet:stimulus:field"]
```

Which entry types should wake this cognet. Absent means everything.

This is the cognet's *default*, and unlike `mode` it is overridable by the agent's
blueprint — the cognet declares what it was built to handle, the agent narrows it for its
own deployment.

## `maxTicksPerWake` — the runaway guard

```ts
maxTicksPerWake: 32
```

A hard bound, not a scheduling mechanism. A wake that hasn't converged in this many ticks
is a loop bug or a stuck model, not progress, and the host throws rather than spinning.

Strategy may stop earlier and usually does — `zero` typically converges in two or three
ticks. Defaults to 8 when omitted.

## `models` — the weights this brain needs

```ts
models: {
    vad: "hf:onnx-community/silero-vad/onnx/model.onnx",
    asr: "hf:ggerganov/whisper.cpp/ggml-base.en.bin",
}
```

`axon prepare` fetches each one, verifies it, and caches it in
`~/.axon/models/<sha256>/` — machine-wide, so ten agents running the same 150MB whisper
share one copy. The paths arrive at load through `kernel.models`:

```ts
const session = await ort.InferenceSession.create(kernel.models.vad)
```

**A map, because the key is your vocabulary.** `vad` says what the weight is *for*; the
specifier says where it came from. Swapping to a different VAD is one line here rather
than an edit at every call site.

**Weights are data, not code.** A `.onnx` file is inert until something reads it. The
runtime that executes it — `onnxruntime-node`, `llama.cpp` — is an ordinary npm
dependency you import, chosen by you. This field only says which bytes are needed.

That is also why there is no unified `runModel()`: every model has its own tensor
signature, so a generic invoke could only pass `unknown` through. Acquisition collapses
to one mechanism; inference cannot.

The object form exists for a revision pin or an expected hash:

```ts
models: {
    vad: { hf: "onnx-community/silero-vad", file: "onnx/model.onnx", sha256: "a4a068..." },
}
```

Pinning `sha256` is the difference between *verified* and *verified against something you
chose* — without it, the first fetch is trust-on-first-use.

A declared model that cannot be fetched fails `axon prepare`. A brain without its weights
is broken rather than degraded, and finding that out at first inference is worse.

## What isn't here

No engine selection, no prompt, no policy, no paths. Those belong to the *agent*, in
`axon.config.ts`.

`models` is the one apparent exception, and it isn't: a cognet declares *which weights it
needs*, never where they live. The resolved path is environmental and arrives through the
kernel like everything else — the same brain gets a different absolute path on every
machine and never learns that.

A cognet cannot read any of them. It declares who it is and how it wants to be woken;
everything about the environment it runs in is on the other side of the
[kernel contract](/docs/v2/cognets/engine/kernel-contract).
