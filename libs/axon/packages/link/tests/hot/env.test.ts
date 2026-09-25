import { describe, expect, it } from "bun:test"
import { resolveEnv, withheldMessage } from "../../src/confine/env"

/**
 * What the box receives.
 *
 * This is the seam that closed the single widest hole in the policy layer: the
 * environment was `{ ...process.env }`, so every provider key and token in the
 * invoking shell was handed to model code — while the `fs` policy carefully
 * denied reading `.env` off disk. It was live under `isolation: "none"` too,
 * which is the default, so no policy setting escaped it.
 *
 * Deny-by-default is only adoptable if it is also legible, which is why
 * `withheld` is tracked rather than the box simply going quiet.
 */

describe("building the box's environment", () => {
    it("does NOT inherit the host", () => {
        const { env } = resolveEnv({
            agentEnv: {},
            policy: undefined,
            host: { ANTHROPIC_API_KEY: "sk-live", DATABASE_URL: "postgres://..." },
        })
        expect(env).toEqual({})
    })

    it("carries the agent's own .env — the common case needs no policy", () => {
        const { env } = resolveEnv({
            agentEnv: { GITHUB_TOKEN: "from-dotenv" },
            policy: undefined,
            host: {},
        })
        expect(env.GITHUB_TOKEN).toBe("from-dotenv")
    })

    it("carries a host variable the policy explicitly grants", () => {
        const { env } = resolveEnv({
            agentEnv: {},
            policy: { allow: ["CI_TOKEN"] },
            host: { CI_TOKEN: "from-host", OTHER: "nope" },
        })
        expect(env).toEqual({ CI_TOKEN: "from-host" })
    })

    it("lets a grant OVERLAY the agent's .env, so CI injection works unedited", () => {
        const { env } = resolveEnv({
            agentEnv: { TOKEN: "local" },
            policy: { allow: ["TOKEN"] },
            host: { TOKEN: "from-ci" },
        })
        expect(env.TOKEN).toBe("from-ci")
    })

    it("is not an error to grant a variable the host does not set", () => {
        // A grant says "may cross", not "must exist" — an agent should still
        // boot on a machine where an optional token is simply absent.
        const { env } = resolveEnv({ agentEnv: {}, policy: { allow: ["ABSENT"] }, host: {} })
        expect(env).toEqual({})
    })

    it("refuses a .env that overrides a framework-owned variable", () => {
        // The deploy path always refused this; the LOCAL path did not, so an
        // agent could reidentify itself to the platform on your machine.
        expect(() => resolveEnv({ agentEnv: { AGENT_ID: "spoofed" }, policy: undefined, host: {} }))
            .toThrow(/framework-owned/i)
    })

    it("reports a host variable that is SET but not granted", () => {
        // The whole point: the denial can then name the variable and the fix,
        // rather than surfacing as a downstream 401 nobody can trace.
        const { withheld } = resolveEnv({
            agentEnv: {},
            policy: undefined,
            host: { STRIPE_SECRET_KEY: "sk-live" },
        })
        expect(withheld).toContain("STRIPE_SECRET_KEY")
    })

    it("does not report wiring as withheld", () => {
        // Listing PATH and HOME would bury the names that matter under forty
        // that never do.
        const { withheld } = resolveEnv({
            agentEnv: {},
            policy: undefined,
            host: { PATH: "/usr/bin", HOME: "/home/x", LANG: "en", TERM: "xterm", AXON_HOME: "/a" },
        })
        expect(withheld).toEqual([])
    })

    it("does not report a variable the agent already supplies itself", () => {
        const { withheld } = resolveEnv({
            agentEnv: { TOKEN: "mine" },
            policy: undefined,
            host: { TOKEN: "theirs" },
        })
        expect(withheld).not.toContain("TOKEN")
    })
})

describe("the denial message", () => {
    it("names the variable and the line that fixes it", () => {
        const message = withheldMessage("GITHUB_TOKEN")
        expect(message).toContain("GITHUB_TOKEN")
        expect(message).toContain('env: { allow: ["GITHUB_TOKEN"] }')
        // The other route, because .env needs no policy at all and is usually
        // the better answer.
        expect(message).toContain(".env")
    })
})
