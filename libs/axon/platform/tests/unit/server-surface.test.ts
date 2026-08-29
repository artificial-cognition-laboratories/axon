import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * The authored server surface survives the process boundary.
 *
 * The blueprint reaches the agent as JSON — `JSON.stringify` on one side,
 * `JSON.parse` on the other — and routes, middleware and plugins are the
 * three things on it that are FUNCTIONS. JSON drops a function silently, so
 * each entry arrived carrying its metadata and nothing to call: `mountRoute`
 * registered a route whose handler was `undefined`, h3 accepted it, and every
 * request to an authored path 404'd with no warning at either end.
 *
 * Middleware was the dangerous half, and its own type doc names the failure
 * exactly — "a request path running without the checks its author wrote — a
 * security hole that looks like a working server". That shipped: an agent
 * whose auth middleware silently did not run.
 *
 * The property under test is not "handlers are present" — it is that NOTHING
 * relies on a function crossing that seam. So this asserts the serialization
 * really does drop them (so the reason for the rehydration stays visible)
 * and that the agent rebuilds the surface itself.
 */

const AGENT_MAIN = readFileSync(
    join(import.meta.dir, "../../src/link/agent-main.ts"),
    "utf-8",
)

describe("server surface — crossing the process boundary", () => {
    it("JSON cannot carry a handler — the reason the rehydration exists", () => {
        // Stated as a test rather than a comment: if a future change makes
        // the blueprint travel some other way, this fails and points at the
        // rehydration as the thing to reconsider.
        const route = {
            method: "POST",
            path: "/api/a",
            file: "/agent/server/api/a.post.ts",
            handler: () => "never survives",
        }

        const crossed = JSON.parse(JSON.stringify(route)) as typeof route

        expect(crossed.path).toBe("/api/a")
        expect(crossed.handler).toBeUndefined()
    })

    it("the agent rebuilds its server surface rather than trusting the blueprint", () => {
        expect(AGENT_MAIN).toContain("rehydrateServer")
        // Before Axon() boots: the runtime mounts what the blueprint holds at
        // construction, so rebuilding after would be rebuilding too late.
        const rehydrate = AGENT_MAIN.indexOf("await rehydrateServer(")
        const boot = AGENT_MAIN.indexOf("await Axon({")
        expect(rehydrate).toBeGreaterThan(-1)
        expect(rehydrate).toBeLessThan(boot)
    })

    it("rebuilds all THREE function-carrying surfaces", () => {
        // Routes alone would have fixed the visible 404 and left the security
        // hole open — middleware and plugins carry functions too, and neither
        // carries a file path that would let them be recovered any other way.
        expect(AGENT_MAIN).toContain("Routes(source.root")
        expect(AGENT_MAIN).toContain("Middleware(source.root")
        expect(AGENT_MAIN).toContain("Plugins(source.root")
    })

    it("scans modules as well as the agent's own root", () => {
        // A module's routes and middleware are part of the merged surface the
        // supervisor assembled; rebuilding only the agent's own would drop
        // every module's server contribution instead.
        expect(AGENT_MAIN).toContain("blueprint.modules")
    })

    it("keeps the agent's own source STRICT and a module's degradable", () => {
        // The same asymmetry the supervisor-side scan uses: an agent running
        // a subset of what its author wrote is invalid, while an agent with
        // one broken module is the agent it was before the install.
        expect(AGENT_MAIN).toContain("required: true")
        expect(AGENT_MAIN).toContain("required: false")
    })
})
