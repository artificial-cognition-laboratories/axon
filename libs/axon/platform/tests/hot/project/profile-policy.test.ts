import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readPolicy } from "@arcforge/platform/build/extensions"

/**
 * The machine-wide policy ceiling, read off `profile.config.ts`.
 *
 * Read by AST — no import, no evaluation, no lock — which is what lets the
 * blueprint path resolve it on every agent load, including `axon run` in a
 * script. The extensions loader IMPORTS the user's TypeScript behind a
 * serialized lock; a ceiling that depended on that would only apply when the
 * TUI happened to have loaded a config, and an advisory ceiling is not a
 * ceiling.
 */

async function withProfile<T>(source: string | null, run: (root: string) => Promise<T>): Promise<T> {
    const root = await mkdtemp(join(tmpdir(), "axon-profile-policy-"))
    try {
        if (source !== null) await writeFile(join(root, "profile.config.ts"), source)
        return await run(root)
    } finally {
        await rm(root, { recursive: true, force: true })
    }
}

describe("reading a profile's policy", () => {
    test("parses every rule shape a policy can carry", async () => {
        // Bare verdicts, glob objects, and keys that are not identifiers — a
        // host:port is the normal case for a network rule and would be the
        // first thing to break under a naive property read.
        const source = `
export default defineProfile({
    settings: { theme: "arcnight" },
    policy: {
        isolation: "auto",
        process: { run: { allow: ["bun run *"], deny: ["rm -rf*"] }, spawn: false },
        network: { "api.example.com:443": true, "*": "escalate" },
        tools: { github: "escalate" },
    },
})
`
        await withProfile(source, async root => {
            expect(await readPolicy(root)).toEqual({
                isolation: "auto",
                process: { run: { allow: ["bun run *"], deny: ["rm -rf*"] }, spawn: false },
                network: { "api.example.com:443": true, "*": "escalate" },
                tools: { github: "escalate" },
            })
        })
    })

    test("a profile with no policy block declares no ceiling", async () => {
        // Distinct from an empty one only in intent, but both mean the same
        // thing downstream: every capability falls through to the agent.
        await withProfile(`export default defineProfile({ settings: { theme: "x" } })`, async root => {
            expect(await readPolicy(root)).toEqual({})
        })
    })

    test("no profile.config.ts at all is not an error", async () => {
        // `axon run` outside a profile, and a freshly scaffolded one. A throw
        // here would make a missing config unbootable.
        await withProfile(null, async root => {
            expect(await readPolicy(root)).toEqual({})
        })
    })

    test("policy is read from the top level, never from settings", async () => {
        // `ProfileSettings` is deliberately "the keys the terminal acts on";
        // policy is read by the RUNTIME. A policy nested under settings is a
        // user mistake, and silently honouring it would make the boundary
        // meaningless.
        const source = `
export default defineProfile({
    settings: { policy: { tools: { github: false } } },
})
`
        await withProfile(source, async root => {
            expect(await readPolicy(root)).toEqual({})
        })
    })

    test("a syntactically broken config yields no ceiling rather than throwing", async () => {
        // Fails OPEN, matching the rest of the profile: the config's own
        // loader reports the breakage, and a ceiling that made a typo
        // unbootable would strand the user in the file they need to fix.
        await withProfile(`export default defineProfile({ policy: {`, async root => {
            expect(await readPolicy(root)).toEqual({})
        })
    })
})
