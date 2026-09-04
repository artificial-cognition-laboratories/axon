import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Agents, isRegistryRef } from "@arcforge/platform/build/bench/agents"
import { toAxes } from "@arcforge/platform/build/bench/axes"
import { describe, it, expect } from "bun:test"

/**
 * The agent axis takes a path you wrote or a registry ref you trust. Both must
 * arrive at a PREPARED project, and both must pin an identity the manifest can
 * carry — a hash of the string "./fixtures/subject" says nothing anyone else
 * could compare against.
 */

async function benchRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "axon-bench-agents-"))
    await mkdir(join(root, "fixtures", "subject"), { recursive: true })
    await writeFile(join(root, "fixtures", "subject", "axon.config.ts"), "export default defineAgent({ name: 'subject' })\n")
    return root
}

describe("bench agents", () => {
    it("treats a bare value as a single-variation axis", () => {
        // `agent: "@axon/coding-base"` and `agent: ["@axon/coding-base"]` are
        // the same declaration — a held constant is still an axis, because a
        // result is only comparable if what did NOT vary is recorded too.
        const [bare] = toAxes({ agent: "@axon/coding-base" } as never)
        const [wrapped] = toAxes({ agent: ["@axon/coding-base"] } as never)

        expect(bare?.values.map(v => v.value)).toEqual(["@axon/coding-base"])
        expect(bare?.values.map(v => v.id)).toEqual(wrapped?.values.map(v => v.id))
    })

    it("distinguishes registry refs from paths", () => {
        expect(isRegistryRef("@axon/coding-base")).toBe(true)
        expect(isRegistryRef("./fixtures/subject")).toBe(false)
        expect(isRegistryRef("../shared/agent")).toBe(false)
    })

    it("prepares a local agent so a cell can boot it", async () => {
        // A local agent still needs node_modules and generated types, and a
        // bench author should not have to know that. Without this, every cell
        // fails at boot with an error that says nothing about the cause.
        const root = await benchRoot()
        const prepared: string[] = []

        try {
            const agents = Agents({
                root,
                clone: async () => { throw new Error("a local path must never reach the registry") },
                prepare: async target => { prepared.push(target) },
            })

            const resolved = await agents.resolve(toAxes({ agent: "./fixtures/subject" } as never))

            expect(prepared).toEqual([join(root, "fixtures", "subject")])
            expect(resolved.get("./fixtures/subject")?.pin).toBe("./fixtures/subject")
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    }, 30_000)

    it("pins a registry agent to its resolved version, not its path", async () => {
        // THE reason registry refs matter: `@axon/coding-base@1.2.0` is an
        // identity two people can compare results across. A path is not.
        const root = await benchRoot()

        try {
            const agents = Agents({
                root,
                clone: async (ref, cwd, options) => ({
                    name: "@axon/coding-base",
                    version: "1.2.0",
                    root: join(cwd, options.dir ?? "agent"),
                }),
                prepare: async () => { throw new Error("clone() already prepares — this must not run twice") },
            })

            const resolved = await agents.resolve(toAxes({ agent: "@axon/coding-base" } as never))
            const agent = resolved.get("@axon/coding-base")

            expect(agent?.pin).toBe("@axon/coding-base@1.2.0")
            // Fetched into .bench/, not fixtures/: it is a materialized
            // dependency, not source the author wrote and commits.
            expect(agent?.root.startsWith(join(root, ".bench", "agents"))).toBe(true)
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    }, 30_000)

    it("fetches a repeated ref once", async () => {
        // Two variations naming the same agent would otherwise race to write
        // the same directory.
        const root = await benchRoot()
        let fetches = 0

        try {
            const agents = Agents({
                root,
                clone: async (ref, cwd, options) => {
                    fetches++
                    return { name: "@axon/coding-base", version: "1.2.0", root: join(cwd, options.dir ?? "agent") }
                },
                prepare: async () => {},
            })

            await agents.resolve(toAxes({ agent: ["@axon/coding-base", "@axon/coding-base"] } as never))

            expect(fetches).toBe(1)
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    }, 30_000)
})
