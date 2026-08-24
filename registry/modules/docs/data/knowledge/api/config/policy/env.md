---
title: env
---

# env

Controls which env vars the capsule subprocess can see. Applied before the subprocess
starts — the agent cannot read stripped vars via `process.env`. Works on all platforms.

```ts
type EnvPolicy = {
    stripEnv?: string[]   // var names or glob patterns to remove
    keepEnv?:  string[]   // preserve these even if matched by stripEnv
}
```

```ts
export default defineAgent({
    policy: {
        user:     "axon-agent",
        stripEnv: ["DATABASE_*", "*_SECRET", "INTERNAL_*"],
        keepEnv:  ["OPENAI_API_KEY"],
    },
})
```

Order of evaluation: strip everything matching `stripEnv`, then restore anything in
`keepEnv`. `keepEnv` preserves the value from the host environment — it does not inject
values, only rescues vars that would otherwise be stripped.

## Default strip patterns

When [`user`](/docs/v2/api/config/policy/user) is set to anything other than `"inherit"`
and `stripEnv` is not explicitly declared, these patterns are applied automatically:

```ts
["*_SECRET", "*_KEY", "*_TOKEN", "*_PASSWORD", "DATABASE_*", "*_DSN"]
```

Setting `stripEnv` explicitly replaces the defaults entirely — the explicit list is used
as-is, not merged. Set to `[]` to disable all stripping.

When `user` is `"inherit"` and `stripEnv` is not set, env passes through unchanged.

## Typical patterns

```ts
export default defineAgent({
    policy: {
        user:     "axon-agent",
        // strip everything sensitive, keep only what the agent needs
        keepEnv:  ["OPENAI_API_KEY", "GITHUB_TOKEN"],
    },
})
```

Relying on the defaults and using `keepEnv` to rescue specific vars is the most robust
pattern — new secrets added to the host environment are stripped automatically without
requiring config changes.
