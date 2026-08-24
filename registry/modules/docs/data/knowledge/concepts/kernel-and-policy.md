---
title: Kernel & Policy
---

# Kernel & Policy

Your agent runs the way a process runs on an operating system. The **kernel** — the
trusted core of the runtime — owns the machine: the filesystem, the network, the shell.
Agent code never touches any of it directly. It runs in the **capsule**, an
unprivileged, isolated subprocess. Every action crosses from the capsule to the kernel
as a request, and the kernel checks it against your policy before anything executes.

That's the whole security model in one sentence: the capsule can *request*; only the
kernel can *take*. The model is treated as untrusted — full stop. The kernel exists to
protect your resources from it, and that isn't a guardrail layered on top of the
architecture. It is the architecture.

Most "agent security" is a system prompt asking the model to behave — instructions it
can ignore, forget, or be talked out of. Axon's isn't. Your policy is enforced at the
process boundary, and on Linux, by the operating system itself. The model can want
whatever it wants; the privileges simply aren't there.

## Why a separate process

**Failures are contained.** A tool that throws, leaks memory, calls `process.exit()`,
or crashes outright takes down the capsule — not the agent. The kernel detects the
failure, surfaces it as a structured error, and the agent continues.

**Enforcement is structural.** There is no code path from agent-emitted code to the
filesystem, network, or shell that doesn't pass through the kernel. The model cannot
override its own constraints — not because it's been instructed not to, but because
the process it runs in simply doesn't have the privileges.

**The boundary is real OS machinery.** Because the capsule is a genuine OS process, it
can run as a genuine OS user — and on Linux, it does. That puts decades-hardened
security primitives between the model and your machine: user permissions, filesystem
ACLs, process isolation. Axon doesn't reimplement any of it; it leverages what the
kernel of your operating system has been enforcing for fifty years. macOS and Windows
don't offer the same primitives — if you want the full posture, run on Linux. Your
cloud deployment already does.

## Policy is what you tell the kernel to allow

Declared once in `axon.config.ts`. The kernel applies it at every enforcement layer
available on the host system.

```ts
export default defineAgent({
    policy: {
        fs: {
            read:  ["./src/**", "./package.json"],
            write: ["./src/**"],
            deny:  ["**/.env*", "**/node_modules/**"],
        },
        network: {
            allow: ["api.github.com"],
        },
        process: {
            allow: ["git *", "bun test", "bun run *"],
            deny:  ["git push --force*"],
        },
    },
})
```

A call that violates policy is rejected before the function runs. The agent receives a
structured error and adapts from there.

**No policy block means unrestricted access, not denied access.** This is intentional
for local development. For anything deployed or published, declare explicit rules.

## How the kernel enforces

Two independent tiers, both driven by the same declaration.

**The policy gate** runs on every platform. Before any agent-emitted call executes,
the kernel evaluates it against your rules — a denied call never reaches the function
body. This tier also handles escalation: pausing execution and surfacing a call for
human approval when a rule requires it.

**OS-level enforcement** runs on Linux when `user` is set. The capsule and everything
it spawns runs as that system user; filesystem ACLs derived from your `fs` policy are
applied at boot, and sensitive env vars are stripped from the capsule's environment
before it starts. A call that somehow slipped the policy gate still hits a wall the
operating system itself enforces.

```ts
export default defineAgent({
    policy: {
        fs: {
            read:  ["./src/**"],
            write: ["./output/**"],
            deny:  ["**/.env*"],
        },
        user: "axon-agent",
    },
})
```

On macOS and Windows, the policy gate and env stripping apply; OS-level enforcement is
Linux-only.

## Per-invocation narrowing

The base policy applies to every invocation. Individual calls can narrow it further —
the standard move for routes handling untrusted input:

```ts
const result = await axon.request({
    prompt,
    policy: {
        fs:      { read: false, write: false },
        process: { allow: [] },
    },
})
```

Narrowing can only restrict. A call can never grant access beyond the base policy, and
the narrowed policy clears when the invocation completes.

## Escalation

For calls that need a human decision, `escalate` pauses execution and surfaces the call:

```ts
policy: {
    process: {
        allow:    ["git *"],
        escalate: ["git push*"],
    },
}
```

The TUI shows the call and waits for approval. Headless, with no TUI attached, an
unresolved escalation fails closed after the timeout (default 30 seconds).

## What the agent sees

A blocked call comes back as a structured policy error — the agent doesn't see the
rules themselves. A well-written agent explains what it tried and either takes another
approach or tells you it needs broader access.

## What this does and does not protect against

**Protects against:**

- Tool failures crashing the agent runtime
- Agent-emitted code touching the filesystem, network, or shell outside declared policy
- A bad tool implementation calling `process.exit()` and killing the agent
- Per-invocation policy violations in routes handling untrusted input
- On Linux with `user` set: even a gate bypass cannot read or write what the OS user
  has no access to, or see env vars stripped at boot

**Does not protect against:**

- A tool with legitimate network access exfiltrating data through an allowed endpoint.
  Policy gates which APIs can be called, not what data flows through them.
- Resource exhaustion before limits trigger. Resource counters are best-effort, not
  hard kernel limits.
- Deliberate exploitation of the runtime itself. Trust your tool implementations.

For the full policy field reference, see [Policy](/docs/v2/agent/policy).
