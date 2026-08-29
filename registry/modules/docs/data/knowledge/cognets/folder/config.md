---
title: cognet.config.ts
description: What a brain declares — how the scheduler wakes it, what it wakes on, what inference it needs.
---

# cognet.config.ts

What this brain *declares*. Pure data, no logic, no lifecycle. Behaviour lives in
`src/main.ts`, identity in `package.json`, and the compile step composes the three.

```ts
export default defineCognet({
    mode: { kind: "invocation" },

    // runaway guard: a wake that hasn't converged in this many
    // render→infer→act ticks is a loop bug or a stuck model, not progress
    maxTicksPerWake: 32,
})
```

Every field is optional except `mode`, and the whole file is optional too — a cognet
with no `cognet.config.ts` is invocation-mode with no wake mask, which is what most
first brains are.

## Fields

| Field | Required | What it declares |
|---|---|---|
| `mode` | yes | How the scheduler wakes it. |
| `wakeOn` | no | Default wake mask. Absent means wake on everything. |
| `maxTicksPerWake` | no | Hard safety bound for one wake. Absent means unbounded. |
| `engines` | no | The inference roles this brain needs. |
| `models` | no | Model weights this brain needs. Fetched, verified and cached by Axon. |
| `abi` | no | Pin the kernel ABI. Absent means the one it was compiled against. |

## What identity isn't here

`name` and `version` are **not** declared. A cognet is an ordinary package, and its
`package.json` already carries both — it is what the registry publishes under, what the
installer resolves, and what an agent writes in its dependencies.

They used to live here as well, and two writable copies of one fact drifted exactly as
duplicated facts do: `@axon/zero` shipped as `1.0.44` while telling the kernel it was
`0.1.2`, because publish read the package and the runtime read the config. Identity has
one home now.

## `abi` — the compatibility contract

A cognet is versioned against the kernel the way a binary is versioned against syscalls.
Omit it and the compile step stamps in the ABI it built against, which is the truthful
answer: a cognet publishes as *source* and is compiled by the consumer against the kernel
it will actually run on.

```ts
abi: "11"
```

Pin it only to make a cognet **refuse** a kernel it hasn't been validated against.
`axon prepare` then checks the pin against the kernel the installed Axon provides and
fails there, naming both versions and the file to edit — a cognet pinned to an older ABI
never half-loads.

## `mode` — invocation or continuous

Part of the cognet's own declared shape, deliberately **not** blueprint-overridable.
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
ticks. Omitted means unbounded, which is the right default for open-ended work: what
bounds a wake there is `<done/>`, the user's interrupt, and the engine failing loudly.

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

A cognet cannot read any of them. It declares how it wants to be woken and what it needs;
everything about the environment it runs in is on the other side of the
[kernel contract](/docs/v2/cognets/engine/kernel-contract).
