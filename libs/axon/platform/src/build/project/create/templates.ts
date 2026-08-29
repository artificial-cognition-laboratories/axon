// ── Agent templates ───────────────────────────────────────────────────────────

// https://axon.arclabs.it/docs/v2/agent/config
//
// Identity (name, version, description) lives in package.json, so the config
// carries none of it — which is why this takes no arguments.
//
// EMPTY BY DESIGN. Inference is not the agent's to declare: a user's
// providers live on their profile and every agent inherits them, which is
// what makes installing an agent a download rather than a setup. Scaffolding
// `providers: [Axon()]` here would bake the author's own source setup into
// every agent they publish — the exact coupling the profile cascade exists to
// remove. An agent adds `providers:` only when it needs a source its user
// would not otherwise have, and `model:` only to express a preference.
export const AGENT_CONFIG_TEMPLATE = () => `// https://axon.arclabs.it/docs/v2/agent/config
export default defineAgent({})
`

export const GITIGNORE_TEMPLATE = `.env
node_modules/
.agent/
data/knowledge/*/index/
`

export const BOOT_VUE = `<template></template>

<script setup lang="ts">
// Boot runs once when the agent starts.
// Load knowledge, set context, or run any startup logic here.
</script>
`

/**
 * bunfig.toml — the @axon scope → registry mapping, plus the test preload
 * that makes Axon() a global in test files.
 *
 * The scope block is what lets `bun install` fetch Axon modules directly:
 * without it Bun looks for @axon/* on npmjs.com and fails. Public modules
 * need no credential, which is why this file is safe to commit and why a
 * fresh clone installs with no setup.
 *
 * The trailing "/-" is load-bearing — Bun resolves the package name
 * against this URL as a RELATIVE reference, replacing the final segment.
 * Without a throwaway segment to consume, "@axon/x" would be requested
 * from "/api/registry/" and 404.
 */
export const BUNFIG_TEMPLATE = (apiBase: string) => `[install.scopes]
axon = { url = "${apiBase}/api/registry/npm/-" }
`

/**
 * The scaffolded project's package.json.
 *
 * @arcforge/types + @arcforge/engines are pinned to the EXACT CLI version:
 * the generated .agent/axon.d.ts is produced by this CLI, so the installed
 * framework types must match it exactly — a range would let them drift. h3 is
 * a real dependency because the generated .d.ts references `import("h3")`
 * handler types. All three resolve through ordinary node resolution once
 * `bun install` runs — no machine-local tsconfig paths.
 */
export const PACKAGE_JSON_TEMPLATE = (name: string, frameworkVersion: string) =>
    JSON.stringify(
        {
            name,
            version: "0.1.0",
            private: false,
            type: "module",
            dependencies: {
                "@arcforge/types": frameworkVersion,
                "@arcforge/engines": frameworkVersion,
                h3: "^1.13.0",
            },
        },
        null,
        2
    ) + "\n"

// ── TypeScript config templates ───────────────────────────────────────────────

// ── Module templates ──────────────────────────────────────────────────────────

export const MODULE_CONFIG_TEMPLATE = () => `export default defineModule({
    // env: {
    //     MY_API_KEY: { required: true, description: "API key for the service" },
    // },
})
`

