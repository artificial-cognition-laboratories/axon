---
title: Data & Privacy
---

# Data & Privacy

This is not a privacy policy. It is an architectural description — where your agent
runs, where its data lives, and what leaves the machine.

The short version: **the runtime runs where you run it.** The loop, the capsule, your
tools, your data — all of it executes on your machine in local development, or inside
your agent's own container when deployed. What crosses the network is determined by two
things you choose: your engine, and your policy.

## The kernel is the perimeter

Every action the agent takes — every file read, every shell command, every network call
— is checked by the kernel against the policy you declared in
`axon.config.ts` before any code runs. There is no path around it: the agent process has
no direct access to the filesystem, network, or shell.

```ts
export default defineAgent({
    policy: {
        fs: {
            read:  ["./src/**"],
            write: ["./output/**"],
            deny:  [".env", "**/secrets/**"],
        },
        network: {
            allow: ["api.github.com"],
        },
    },
})
```

An agent with this policy cannot read `.env`, cannot write outside `./output/`, cannot
reach any host but `api.github.com`. The model may want to. The kernel won't let it.

Your privacy posture *is* your policy — committed to git, auditable,
version-controlled. Tighten it to what the agent genuinely needs. See
[Kernel & Policy](/docs/v2/concepts/kernel-and-policy) for how enforcement works.

## Where tokens go

Inference is the one flow that necessarily leaves the agent, and the
[engine](/docs/v2/agent/runtime/engines) decides where it goes:

**`Axon()`** — managed inference through Axon Cloud, billed to your account. Context
windows flow to Axon and on to the model provider.

**`OpenRouter()`, `Codex()`, `Cerebras()`** — tokens flow from your machine directly to
your provider. Axon is not in that path. Your provider contract governs that surface.

**`Ollama()`** — inference on your own hardware. **No tokens leave your machine.** The
full runtime — loop, capsule, tools — was already local; with a local engine,
everything is.

## The isolation spectrum

Different threat models, increasing separation — each step is a deployment choice, not
a configuration system:

**Local development** — everything on your machine; inference via whichever engine you
chose. With `Ollama()`, fully self-contained.

**Axon Cloud deployment** — your agent runs in its own isolated container with its own
durable `data/`. Axon manages the infrastructure; your policy still governs everything
the agent does inside it.

**Self-managed** — `axon build` produces a container image you can run on your own
infrastructure, with your own engine choice. Combined with local inference, no tokens
leave hardware you control.

You define the environment. You define the policy. The agent operates within both.
