---
title: modules
---

# modules

The modules this agent loads. An **array** of entries — each entry is a module
name (or an imported module config), optionally paired with an options object
in a `[module, options]` tuple.

```ts
export default defineAgent({
    modules: [
        // no options — just the name
        "@axon/fs",

        // with options — a [name, options] tuple
        ["@axon/github", { owner: "acme", repo: "backend" }],
        ["@axon/slack", { channel: "#eng-alerts", botName: "axon" }],
    ],
})
```

You can also import a local module's config directly instead of naming it:

```ts
import DiscordModule from "../modules/discord/module.config"

export default defineAgent({
    modules: [
        [DiscordModule, { mentionOnly: true }],
    ],
})
```

Options are validated against the module's declared schema, then passed to its
`setup()` as `ctx.options`. A missing required option fails boot with a clear error.

## What belongs here

Only configuration the module explicitly declares as an option. Not secrets —
those belong in `.env` and accessed via `axon.env`. Not logic — modules handle
their own setup.

## Installing modules

`modules` config only applies to modules already present in the `modules/`
folder. To add a module:

```bash
axon install @acme/github
```

This copies the module source into `modules/` and patches `axon.config.ts` with
any policy the module needs. See [`axon install`](/docs/v2/cli/install).
