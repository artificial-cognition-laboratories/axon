---
title: Publishing
---

# Publishing

Publishing an agent adds it to the Axon registry so others can install it into their own Axon setup. This is separate from [deploying](/docs/v2/deploy) — which gives your agent a live cloud endpoint.

```bash
axon publish
```

Run from the agent folder. Packages the source, generates the registry manifest, and uploads. One command.

## Before you publish

**Test the agent as a fresh install.** The easiest way is to install it locally into a clean agent slot:

```bash
axon install ./path/to/my-agent --as test-agent
axon --agent test-agent
```

This simulates what the installer experiences — a fresh folder, no pre-existing state.

**Tighten the policy.** Review `axon.config.ts` before publishing. The policy is public. Remove any rules that are broader than the agent actually needs.

**Check env declarations.** Every key your agent reads from environment should be declared in `env.needs`. The install prompt surfaces these to the installer so they know what to set up.

**Write a clear description.** One line. What does the agent do, who is it for:

```ts
export default defineAgent({
    identity: {
        name: "dev-workflow",
        description: "GitHub + Linear developer workflow agent for TypeScript projects",
    },
    // ...
})
```

## Versioning

Agent versions follow semver. `axon publish` auto-bumps the patch version. To bump minor or major, update `version` in `package.json` before publishing:

```json
{
    "name": "my-agent",
    "version": "2.0.0"
}
```

Published versions are immutable. Once a version is live, it cannot be changed. Publish a new version to ship changes.

## Registry identity

Your agent is published under your account scope: `@you/agent-name`. The name comes from `identity.name` in `axon.config.ts`. The scope comes from your Axon account.

```
@you/dev-workflow
@you/code-reviewer
@teamname/internal-agent
```

Team accounts can publish under a shared scope. Configure team scope in your account settings at `axon.arclabs.it`.

## What gets published

| Included             | Excluded                                                    |
| -------------------- | ----------------------------------------------------------- |
| `axon.config.ts`    | `.env` — secrets are always agent-local                     |
| `prompts/`           | `node_modules/` — reconstructed by `bun install` on install |
| `scripts/`           | `axon.d.ts`, `tsconfig.json` — regenerated on install       |
| `src/`               | `server/` — routes are not published to the registry        |
| `package.json`       |                                                             |
| `axon.manifest.json` |                                                             |

`server/` routes are not included in a published agent. Routes are deployment-specific — they expose your agent to the internet and are not something an installer takes on. Prompts, scripts, and tools are the portable parts.

## What happens after publish

The agent appears in the registry immediately. Anyone can install it:

```bash
axon install @you/dev-workflow
```

They can inspect your `axon.config.ts`, your policy, your prompts, your scripts — everything in the published package — before running it.

## Updating a published agent

Publish a new version. Installers who want the update run:

```bash
axon upgrade @you/dev-workflow
```

This merges the new version's files into their agent folder. File conflicts (where the installer has modified a file your update also touches) are flagged — the installer resolves them manually. Their changes are never silently overwritten.
