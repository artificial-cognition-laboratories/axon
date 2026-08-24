---
title: Axon
---

# Axon

The default engine. If you're logged in to Axon, it works without any configuration.
Model costs are billed against your Axon account balance.

## Configuration

```ts
import { Axon } from "@arcforge/engines"

export default defineAgent({
    engine: Axon(),
})
```

With a specific model:

```ts
import { Axon } from "@arcforge/engines"

export default defineAgent({
    engine: Axon({ model: "claude-sonnet-4-6" }),
})
```

`model` is optional. Omit it to use the account default, or specify any model ID from
the Axon catalog — including any model available on OpenRouter.

## Switching models at runtime

Open the model palette with `*` in the TUI. All Axon Cloud models are listed with the
Axon indicator. Selecting one overrides the `model` field in `axon.config.ts` for the
current session.

## Billing

Charges appear on your Axon account balance. Top up from the account page at
[axon.arclabs.it](https://axon.arclabs.it) or with `:topup` in the TUI.

No key management required — authentication derives from your logged-in Axon session.
