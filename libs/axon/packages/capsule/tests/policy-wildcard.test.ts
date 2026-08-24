import { readFileSync } from "node:fs"
import { join } from "node:path"
import { POLICY_WILDCARD } from "../src/blueprint"

/**
 * The wildcard literal is duplicated across the confinement boundary.
 *
 * `mediator.ts` is GUEST code: it may import node builtins and type-only
 * declarations and nothing else, because the workspace symlink points outside
 * the confined filesystem and a runtime import kills the subprocess at
 * startup. So it declares its own `POLICY_WILDCARD` rather than importing the
 * host's.
 *
 * Two copies of a join key can drift, and this is the cheap guard against it —
 * the same shape the error codes already use across the same boundary. A drift
 * would not throw: a blanket rule would simply stop matching, and every call
 * it was meant to gate would fall through to deny-by-default.
 */
describe("POLICY_WILDCARD", () => {
    it("matches the literal the guest mediator declares", () => {
        const source = readFileSync(join(import.meta.dir, "..", "src", "process", "mediator.ts"), "utf-8")
        const declared = source.match(/const POLICY_WILDCARD = "(.*)"/)?.[1]

        expect(declared).toBeDefined()
        expect(declared).toBe(POLICY_WILDCARD)
    })

    it("matches the literal the kernel's ceiling resolver declares", () => {
        const source = readFileSync(
            join(import.meta.dir, "..", "..", "..", "kernel", "src", "capsule.ts"),
            "utf-8",
        )
        const declared = source.match(/const POLICY_WILDCARD = "(.*)"/)?.[1]

        expect(declared).toBeDefined()
        expect(declared).toBe(POLICY_WILDCARD)
    })
})
