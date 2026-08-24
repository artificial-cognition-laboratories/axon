---
title: Profile Structure
icon: vscode-icons:default-folder-opened
---

# Your profile

Everything the TUI knows about you lives in one directory, keyed by the account you are
signed in as.

```bash
~/.axon/profiles/<your-email>/
├── .axon/               # generated types — regenerable
├── agents/              # your agents. zeno lands here
├── node_modules/        # installed by bun. regenerable
├── plugins/             # lifecycle hooks — every file auto-loads
├── store/               # history and UI state — NOT regenerable
├── main.ts              # your config: commands, keys, palettes
├── profile.config.ts    # extensions + settings
├── package.json
└── tsconfig.json
```

It is created on first launch and repaired on every boot: a missing folder is added back,
but **a file that already exists is never overwritten**. A broken `main.ts` is still
yours, and replacing it would cost someone their whole config to fix a typo.

## A profile is a project

That is the part worth internalising. It has a `package.json`, a `tsconfig.json`, a
`bun install`, and a generated type frame — the same treatment an agent or a module gets.

Which is why this works with no imports and full autocomplete:

```ts
// main.ts
commands.register("hello", () => tui.info("hi"))
```

The eight globals are declared in `.axon/types/globals.d.ts`, generated from the contract
Axon ships. Your editor reads them because `tsconfig.json` extends that frame.

## What survives a wipe

| | |
|---|---|
| `main.ts` · `profile.config.ts` | **Yours.** Never touched |
| `agents/` | **Yours.** Real projects you can edit and publish |
| `store/` | **Not regenerable.** History and state |
| `.axon/` · `node_modules/` | Regenerable. Delete freely |

Delete `.axon/` or `node_modules/` and the next launch rebuilds them. Delete `store/` and
you lose your input history.

## Not in here

**Installed extensions.** A registry extension is fetched to
`~/.axon/cache/extensions/<scope>/<name>/<version>/` — machine-wide, shared by every
profile, keyed by version. Your profile only records *which* ones it loads, in
`profile.config.ts`.

That is why `axon ext uninstall` undeclares rather than deletes: the files are shared, and
removing them would break a profile you were not touching.
