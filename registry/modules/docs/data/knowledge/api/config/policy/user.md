---
title: user
---

# user

Which OS user to run the capsule subprocess as. Linux only.

```ts
type User = string   // default: "inherit"
```

| Value | Behaviour |
|---|---|
| `"inherit"` (default) | Runs as the invoking user. No OS enforcement. |
| `"axon-agent"` | Subprocess and all children run as `axon-agent`. ACLs applied. Env stripped. |
| Any username | Same as above for the named user. Must exist on the system. |
| `"root"` | Runs as root. ACLs skipped — root bypasses them. Mediator and env stripping still apply. |

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

When `user` is set to anything other than `"inherit"` or `"root"`, the runtime
automatically validates the user exists, applies `setfacl` ACLs derived from `fs`,
strips env vars per [`env`](/docs/v2/api/config/policy/env), and launches the capsule as that user. Hard
error at boot if the user does not exist — no silent fallback.

On macOS and Windows, `user` has no effect. OS enforcement is Linux only.

## Why use this

The mediator gate catches policy violations before tool functions execute. OS enforcement
closes the structural gap: a tool that somehow bypasses the mediator still cannot read
files the system user has no access to, and cannot see env vars that were stripped at
boot. The kernel enforces it.

The `fs` policy you already declared is applied at both layers. No extra configuration —
setting `user` activates OS enforcement automatically.
