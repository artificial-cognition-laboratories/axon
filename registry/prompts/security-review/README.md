# @axon/security-review

Review a diff for security defects, with a reachable path for every finding.

Establishes the trust boundary and what's reachable first, then works a checklist across input handling, access control, secrets, crypto, and configuration.

## Install

```bash
axon install @axon/security-review
```

## Use

```bash
axon run @axon/security-review --text "<what you want done>"
```

From a script:

```ts
const prompt = await axon.prompt("@axon/security-review")
const { stream } = axon.stream({ prompt: [prompt] })
```

## What it does to the agent

Requires a traced path from untrusted input to the weakness before anything counts as a finding — "this looks injectable" is not a report. Findings are ranked by exploitability and state what an attacker actually gets. It won't pad the list with theoretical issues, because that buries the real one, and it won't write exploits.

The checklist lives in `components/checklist.vue`.

## Provenance

Written for this registry. Not ported from an existing skill — the practice
here is standard engineering discipline, stated as constraints an agent will
actually follow.
