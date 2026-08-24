---
title: deploy
---

# deploy

Controls how the agent is packaged and where it runs. All fields are optional —
omitting `deploy` entirely uses Axon Cloud defaults.

```ts
export default defineAgent({
    deploy: {
        target: "axon",
        scaling: { min: 0, max: 3 },
        runtime: {
            packages: ["git", "ripgrep"],
        },
    },
})
```

## target

`"axon"` (default) — deploy to Axon-managed Cloud Run. One command, no infra.

`"self"` — `axon build` produces a `.agent/` folder with a Docker image and a
source tarball. Deploy it anywhere that runs containers. You own the runtime.

```ts
export default defineAgent({ deploy: { target: "self" } })
```

For the self-host story, see [Deploy](/docs/v2/deploy).

## scaling

Controls Cloud Run instance count. Only applies when `target` is `"axon"`.

```ts
export default defineAgent({
    deploy: {
        scaling: {
            min: 0,  // scale to zero when idle (default)
            max: 3,  // max concurrent instances (default)
        },
    },
})
```

Set `min: 1` to keep a warm instance running at all times — eliminates cold
start latency at the cost of always paying for one instance.

## runtime.packages

System packages to install in the container via `apk` (Alpine base image). Add
anything your tools need that isn't already available in a standard Node environment.

```ts
export default defineAgent({
    deploy: {
        runtime: {
            packages: ["git", "ripgrep", "ffmpeg"],
        },
    },
})
```

Packages are installed at build time. Adding a new package requires a redeploy.
