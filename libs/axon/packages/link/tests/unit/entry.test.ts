import { readLinkEnv, writeLinkEnv, AGENT_LINK_ENV } from "../../src/entry"

/**
 * Assertions match the error's DETAIL, not its code: `err()` puts the detail in
 * `.message` and the code on `.code`, and a test matching the code against the
 * message passes only by accident when the two happen to share a word.
 *
 * The env carrier is how a confined agent finds its supervisor: Bun.spawn
 * exposes stdio only, so no pre-connected fd can be inherited and the paths
 * must travel some other way.
 *
 * Every failure here is LOUD by design. A missing or malformed carrier means
 * this process was not started by a supervisor, and an agent that guessed a
 * socket path would either fail obscurely later or connect to a DIFFERENT
 * agent's supervisor — which is a cross-tenant bug, not an inconvenience.
 */
describe("agent link env carrier", () => {
    it("round-trips the two socket paths", () => {
        const paths = { control: "/run/axon/a/control.sock", data: "/run/axon/a/data.sock" }
        expect(readLinkEnv({ [AGENT_LINK_ENV]: writeLinkEnv(paths) })).toEqual(paths)
    })

    it("throws when the carrier is absent", () => {
        expect(() => readLinkEnv({})).toThrow(/is not set/i)
    })

    it("throws when the carrier is not JSON", () => {
        expect(() => readLinkEnv({ [AGENT_LINK_ENV]: "not json" })).toThrow(/AX-AGENT-002|malformed|JSON|paths/i)
    })

    it("throws when a path is missing rather than defaulting one", () => {
        expect(() => readLinkEnv({ [AGENT_LINK_ENV]: JSON.stringify({ control: "/a.sock" }) }))
            .toThrow(/AX-AGENT-002|malformed|JSON|paths/i)
    })

    it("throws when a path is not a string", () => {
        expect(() => readLinkEnv({ [AGENT_LINK_ENV]: JSON.stringify({ control: 1, data: 2 }) }))
            .toThrow(/AX-AGENT-002|malformed|JSON|paths/i)
    })
})
