# Discord module — debt

## [x] Discord is a request/response bot, not a sense channel
**Severity:** high
**Description:**
The module emits a `discord:message.received` hook carrying a `reply` closure,
expecting a server plugin to answer it with its own `axon.request()`. That
spawns an isolated wake per message outside the scheduler, so the agent has no
continuity across its own conversation — each message is answered by a mind
that remembers nothing of the last one. This is the same architecture the
Telegram module was just rewritten away from. The clean version: the gateway
listener calls `axon.stim("cognet:stimulus:text", { channel: "discord:<id>",
content: "<sender>: <text>" })`, the hook and its `reply` closure are deleted,
and the brain answers with a `discord.send(channel, text)` tool. See
`registry/modules/telegram/` for the reference shape and the channel-naming
convention documented in `libs/axon/types/src/session/events/stdio/shared.ts`.
**Resolved:** The gateway listener now calls `axon.stim("cognet:stimulus:text",
{ channel: "discord:<channelId>", content: "<sender>: <text>" })`. The `emits`
block, the `discord:message.received` hook and its `reply` closure are deleted;
`discord.send` accepts the channel address and returns a receipt.
**References:**
- registry/modules/discord/module.config.ts — `emits`, `setup()` gateway handler
- registry/modules/discord/src/tools/discord.ts — tool surface, no `send` verb
- registry/modules/telegram/module.config.ts — reference implementation

## [ ] Module-authoring docs teach the retired hook pattern
**Severity:** medium
**Description:**
`docs/v2/modules/building.md`, `config.md` and `tests/index.md` all use
`discord:message.received` + a `reply` closure as their worked example of
`emits`/`callHook`. That is the exact request/response shape both Telegram and
Discord were rewritten away from — a plugin answering with its own
`axon.request()` spawns an isolated wake per message and bypasses the
scheduler. The docs now teach the anti-pattern using a module that no longer
does it. `emits` is still a real feature and deserves an example, but it should
be one where a hook is the right answer (a lifecycle signal, not an inbound
message), with channel modules pointed at `stim`.
**References:**
- apps/axon.arclabs.it/content/docs/v2/modules/building.md — lines 45, 60, 110
- apps/axon.arclabs.it/content/docs/v2/modules/config.md — lines 28, 136, 149, 195
- apps/axon.arclabs.it/content/docs/v2/modules/tests/index.md — line 102
- registry/modules/docs/data/knowledge/modules/ — mirrored copies
