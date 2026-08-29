import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * Confinement is a STRUCTURAL guarantee, so these are structural tests.
 *
 * An agent always runs as its own process. The path that used to boot one in
 * the caller's heap — `Agent()` with no `confined` supplier — ran agent code,
 * its tools and every model-emitted block inside the CLI, where no OS box
 * surrounds it and policy cannot be enforced against the process doing the
 * enforcing. That is a hole in the user policy contract rather than a
 * performance choice, so the option to open it was removed outright.
 *
 * Asserted against the SOURCE rather than by calling `Agent()`, because the
 * property being protected is "there is no second way in". A behavioural test
 * can only prove the door it knows about is shut; reading the type proves
 * none was left ajar. These are cheap, and they fail loudly the moment
 * someone makes `confined` optional again "just for tests".
 */

const AGENT_SRC = readFileSync(
    join(import.meta.dir, "../../src/build/runtime/agent.ts"),
    "utf-8",
)

describe("confinement — an agent is always its own process", () => {
    it("requires a confined supplier — the in-heap path cannot be reached", () => {
        // `confined?:` would restore the fork. The whole guarantee rests on
        // this one character.
        expect(AGENT_SRC).toContain("confined: (input: {")
        expect(AGENT_SRC).not.toContain("confined?:")
    })

    it("has no in-heap boot to fall back to", () => {
        // `Agent()` imported `Axon` and constructed it directly when
        // `confined` was absent. Both the call and the kind that named its
        // result are gone.
        expect(AGENT_SRC).not.toContain("kind: \"process\"")
        expect(AGENT_SRC).not.toMatch(/await Axon\(/)
    })

    it("exposes no in-heap runtime handle", () => {
        // `current` handed callers the live AxonT. A linked agent has none —
        // that is the point of the boundary — and offering one that returned
        // undefined is how a consumer forgets the difference until runtime.
        expect(AGENT_SRC).not.toContain("get current()")
    })
})
