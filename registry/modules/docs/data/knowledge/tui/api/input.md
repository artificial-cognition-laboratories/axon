---
title: input
---

# input

The message box the user types into.

```ts
interface InputApi {
    get(): string
    set(text: string): void

    // Append without clearing — the voice-transcript behaviour.
    append(text: string): void

    clear(): void

    // Send to the focused agent as Enter would, and clear. No-op when empty.
    submit(): Promise<void>
}
```

## Drafting for the user

```ts
commands.register("review", {
    async run() {
        const branch = await palette.pick(await gitBranches())
        if (!branch) return

        input.set(`review the changes on ${branch}`)
        // Left in the box — the user hits Enter when ready.
    },
    description: "Draft a review request",
})
```

That is the difference from `agents.send`: the text is visible and editable before it
goes.

## Sending it yourself

```ts
input.set("status report")
await input.submit()   // already cleared afterwards
```

`submit()` takes Enter's own path, so queueing, history and the switching-agent rule all
behave identically — a message submitted while an agent is still booting is **queued**,
not lost.

## Building onto a draft

```ts
commands.register("cite", {
    async run() {
        const file = await palette.pick(await listFiles())
        if (file) input.append(` @${file}`)
    },
    description: "Reference a file",
})
```

`append` adds no separator — space it yourself.

## Mode keys need an empty box

```ts
keys.register("ctrl+b", async () => {
    if (input.get().length > 0) return   // mid-sentence — leave it alone
    await palette.open("branches")
})
```

The same rule the built-in mode keys follow: a `~` typed mid-sentence stays a literal
character.
