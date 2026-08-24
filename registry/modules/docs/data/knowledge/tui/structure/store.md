---
title: store/
icon: vscode-icons:folder-type-docs
---

# store/

**The one part of your profile that cannot be regenerated.**

```bash
store/
├── history.jsonl   # what you have typed
├── state.json      # UI state — last agent, last session
└── profile.json    # the signed-in account
```

Everything else in the profile is either yours to write (`main.ts`,
`profile.config.ts`) or rebuilt on demand (`.axon/`, `node_modules/`). This is neither:
it is produced by using the terminal, and deleting it loses that.

## history.jsonl

Your input history — what `↑` walks back through on an empty box. Append-only, one entry
per line.

Not the conversation. Agent messages and tool calls belong to a **session**, which is
written by the agent, not by the profile.

## state.json

Where you left off: the last focused agent, the last session. Small, and safe to delete —
you lose a resume, not data.

## profile.json

Which account this profile belongs to. Written at sign-in.

## Backing up

```bash
cp -r ~/.axon/profiles/<your-email>/store ~/backup/
```

Worth doing if your history matters to you. Nothing else here needs backing up —
`main.ts` and `profile.config.ts` are worth putting in a dotfiles repo instead, since
they are source.
