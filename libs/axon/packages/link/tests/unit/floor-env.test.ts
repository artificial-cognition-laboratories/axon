import { describe, expect, it } from "bun:test"
import { floorEnv } from "../../src/confined"

/**
 * The environment floor an UNCONFINED agent starts from.
 *
 * ── Why this test exists ────────────────────────────────────────────────────
 *
 * `env.test.ts` covers `resolveEnv` — the POLICY half, which decides what a
 * user's grants let through. `floorEnv` is the other half and had no test at
 * all, which is exactly how a release shipped that could not boot on macOS:
 * tool loading called `os.tmpdir()`, `os.tmpdir()` reads `TMPDIR`, and `TMPDIR`
 * is not on this list. The host resolved `/var/folders/…` and the agent
 * resolved `/tmp`, so every tool import failed.
 *
 * Linux passed throughout — `TMPDIR` is usually unset there, so both sides
 * landed on `/tmp` and agreed by accident. A test asserting the LIST rather
 * than the behaviour is what catches that, because it does not depend on which
 * variables the machine running it happens to have set.
 *
 * ── What a failure here means ───────────────────────────────────────────────
 *
 * Adding a name widens what every unconfined agent can see about its host. If
 * this test fails, the question is not "update the expectation" but "should an
 * agent be able to read that". Removing one is the same question inverted:
 * something inside the agent may already depend on it.
 */

describe("the agent's environment floor", () => {
    it("passes exactly the names it declares, and no others", () => {
        const allowed = new Set(["PATH", "HOME", "PWD", "SHELL", "TERM", "USER", "LOGNAME", "LANG", "TZ"])

        for (const name of Object.keys(floorEnv())) {
            expect(allowed.has(name)).toBe(true)
        }
    })

    it("does not pass TMPDIR", () => {
        // The specific regression. Anything needing scratch space inside the
        // agent derives it from the agent's own frame — see
        // @arcforge/capsule/materialize — rather than from a host variable
        // that may or may not survive the process boundary.
        const previous = process.env.TMPDIR
        process.env.TMPDIR = "/var/folders/decoy"

        try {
            expect(floorEnv().TMPDIR).toBeUndefined()
        } finally {
            if (previous === undefined) delete process.env.TMPDIR
            else process.env.TMPDIR = previous
        }
    })

    it("does not carry a host secret that happens to be set", () => {
        // The floor is an allowlist. A name nobody listed must not appear
        // merely because the invoking shell had it.
        const previous = process.env.ANTHROPIC_API_KEY
        process.env.ANTHROPIC_API_KEY = "sk-live"

        try {
            expect(floorEnv().ANTHROPIC_API_KEY).toBeUndefined()
        } finally {
            if (previous === undefined) delete process.env.ANTHROPIC_API_KEY
            else process.env.ANTHROPIC_API_KEY = previous
        }
    })

    it("omits a listed name the host does not set, rather than passing undefined", () => {
        // A key present with an undefined value is not the same as an absent
        // key: `{ ...floorEnv(), ...env }` would let it clobber a real value.
        const previous = process.env.LOGNAME
        delete process.env.LOGNAME

        try {
            expect("LOGNAME" in floorEnv()).toBe(false)
        } finally {
            if (previous !== undefined) process.env.LOGNAME = previous
        }
    })
})
