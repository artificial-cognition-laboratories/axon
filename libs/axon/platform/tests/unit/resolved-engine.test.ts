import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * Which model an agent is on, reported by an agent that cannot work it out.
 *
 * Nothing is DECLARED any more — the `engine:` field is gone, a user supplies
 * providers and a cognet names roles, and which model serves the cortex is
 * decided at boot by whoever holds the credential. For a confined agent that
 * is the SUPERVISOR: resolution needs the credential, which is precisely what
 * the boundary keeps on the other side.
 *
 * So the agent has no engines of its own, and `/_axon/health` — which read
 * the kernel's — reported `engine: null` on every agent that was answering
 * prompts perfectly well. The field looked broken while the agent was fine,
 * which is the worst shape a status endpoint can take.
 *
 * The answer travels on the blueprint instead: resolved supervisor-side,
 * stamped on before the spawn, carried through normalization, preferred by
 * health. Each of those four steps is one place it can be dropped, and it
 * WAS dropped at normalization first time round — so each is asserted.
 */

function source(...parts: string[]): string {
    return readFileSync(join(import.meta.dir, "../..", ...parts), "utf-8")
}

describe("resolved engine — reaching a confined agent", () => {
    it("the supervisor flattens its resolved binding", () => {
        // services holds the engines because it holds the credential.
        expect(source("src", "link", "services.ts")).toContain("get engine()")
    })

    it("stamps it on the blueprint BEFORE the spawn", () => {
        // After the spawn would be after the blueprint was serialized.
        //
        // Read from the DAEMON, which supervises now. This assertion lived
        // against instances.ts while the platform assembled the supervisor's
        // services inline; that moved to axond so an agent could outlive the
        // terminal that started it. The invariant is unchanged — only the file
        // holding it.
        const supervise = readFileSync(
            join(import.meta.dir, "../../../packages/axond/src/agents/supervise.ts"),
            "utf-8",
        )
        const stamp = supervise.indexOf("services.engine")
        const spawn = supervise.indexOf("await spawnConfined({")

        expect(stamp).toBeGreaterThan(-1)
        expect(stamp).toBeLessThan(spawn)
    })

    it("the blueprint type carries it on both the strict and partial shapes", () => {
        // The partial is what crosses the wire; the strict is what the
        // runtime reads. A field on one and not the other is dropped in
        // normalization, silently.
        const blueprint = readFileSync(
            join(import.meta.dir, "../../../types/src/blueprint.ts"),
            "utf-8",
        )
        expect(blueprint).toContain("engine?: { provider: string; model: string | null }")
        expect(blueprint).toContain(`engine?: AxonBlueprint["engine"]`)
    })

    it("normalization carries it through rather than rebuilding without it", () => {
        // Where it was dropped: AxonBlueprint() builds a strict shape from
        // known fields, so a field it does not name simply vanishes.
        const normalize = readFileSync(
            join(import.meta.dir, "../../../core/src/platform/blueprint.ts"),
            "utf-8",
        )
        expect(normalize).toContain("partial.engine")
    })

    it("health prefers the carried answer over the kernel's engines", () => {
        // The kernel's are correct in-heap and absent when confined, so the
        // carried one has to win — otherwise every confined agent reports
        // null again.
        const endpoints = readFileSync(
            join(import.meta.dir, "../../../core/src/runtime/server/endpoints.ts"),
            "utf-8",
        )
        expect(endpoints).toContain("if (declared) return declared")
        expect(endpoints).toContain("engineIdentity(opts.engines, opts.blueprint.engine)")
    })
})
