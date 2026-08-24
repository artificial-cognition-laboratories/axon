---
title: fs
---

# fs

Controls filesystem access inside the capsule. All patterns are glob strings resolved
relative to the agent folder root.

```ts
type FsPolicy = {
    read?:     string[]   // paths the agent may read
    write?:    string[]   // paths the agent may write or create
    deny?:     string[]   // overrides read and write at every enforcement layer
    escalate?: string[]   // pause and prompt before allowing
}
```

`deny` is checked before `read` and `write`. A path matching `deny` is blocked regardless
of whether it also matches `read` or `write`.

```ts
export default defineAgent({
    policy: {
        fs: {
            read:  ["./**"],
            write: ["./src/**", "./CHANGELOG.md"],
            deny:  ["**/.env*", "**/*.key", "**/node_modules/**"],
        },
    },
})
```

No `fs` block means unrestricted filesystem access. An explicit empty `read: []` blocks
all reads.

## OS enforcement

On Linux with [`user`](/docs/v2/api/config/policy/user) set, the `fs` policy is applied
as `setfacl` ACLs at boot in addition to the mediator gate. The OS enforces the same
grants and denies at the kernel level — a tool that bypasses the mediator still cannot
read files the system user has no access to. `deny` patterns are subtracted from ACL
grants before `setfacl` is called, preserving the same override semantics.

## escalate

Paths matching `escalate` pause execution and surface the call for human approval before
proceeding. Useful for sensitive paths that are sometimes fine and sometimes not.

```ts
export default defineAgent({
    policy: {
        fs: {
            read:     ["./**"],
            escalate: ["./secrets/**", "./.ssh/**"],
        },
    },
})
```

See [`escalate`](/docs/v2/api/config/policy/escalate) for the programmatic escalation
function.
