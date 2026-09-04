# agent-bundle fixture

`source.tar.gz` is the agent bundle every deployment test deploys. It is a
COMPILED artifact — it carries `.agent/cognet/cognet.mjs`, a brain built
against a snapshot of the kernel ABI.

## Rebuilding

```
bun run libs/axon/platform/scripts/rebuild-cloud-fixture.ts
```

Run it whenever `KERNEL_ABI_VERSION` bumps.

`src/` is the agent's own source and the only part a human edits. Everything
else in the tarball — package.json, bun.lock, the compiled cognet — is
scaffolded by the platform at rebuild time, so it cannot drift from the kernel
in this commit.

For that reason `src/` holds no `package.json`. One was committed here once and
was read by nothing: the rebuild scaffolds its own into a temp directory and
copies only `axon.config.ts` and `server/` back out of here. Bun, however, reads
every `package.json` in the repo as a candidate workspace — so that one file
collided with `agent-src` on name and broke `bun install` for the WHOLE
repository until it was removed. Do not put one back.

## Why this exists

The tarball was committed with no way to regenerate it. It targeted ABI 10
against a kernel at 11, and every deployment test failed with
`zero@0.1.2 targets ABI 10, kernel provides 11` — 25 failures, one cause, and
nothing in the repo saying where the bytes came from.

Bumping the manifest's `abi` by hand is the wrong fix and is called out as such
by `KERNEL_ABI_VERSION`: "a stale bundle loads cleanly under a matching version
number and misreads events at runtime."

The rebuild script lives in `libs/axon/platform` rather than here because
building an agent needs the bundler, and `libs/cloud` cannot import it —
platform depends on cloud, so the reverse is a cycle.

`src/` is excluded from this package's tsconfig: it is agent code, written
against the agent's ambient globals (`defineAgent`, `defineEventHandler`),
which only exist inside a prepared agent project.
