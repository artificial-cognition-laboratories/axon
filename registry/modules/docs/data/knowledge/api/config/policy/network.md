---
title: network
---

# network

Controls outbound `fetch()` calls made from within the capsule. Patterns match against
the request hostname.

```ts
type NetworkPolicy = {
    allow?: string[]   // permitted hostnames or patterns
    deny?:  string[]   // blocked hostnames or patterns
}
```

`deny` is checked before `allow`. Subdomains must be listed explicitly or use a wildcard.

```ts
export default defineAgent({
    policy: {
        network: {
            allow: ["api.github.com", "*.linear.app"],
            deny:  ["*"],
        },
    },
})
```

`deny: ["*"]` with a specific `allow` list is the recommended pattern for agents that
only need to reach known endpoints. It blocks everything not explicitly allowed.

No `network` block means unrestricted outbound access. An empty `allow: []` with no
`deny` blocks all network access.

## Wildcard patterns

`*` matches within a hostname segment. `*.github.com` matches `api.github.com` and
`raw.github.com` but not `github.com` itself. To allow a domain and all subdomains, list
both:

```ts
export default defineAgent({
    policy: {
        network: {
            allow: ["github.com", "*.github.com"],
        },
    },
})
```
