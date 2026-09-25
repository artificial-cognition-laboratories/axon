import { fromPolicy } from "../../src/confine/spec"
import { Bwrap } from "../../src/confine/bwrap"
import type { CapsulePolicy } from "@arcforge/types"
import { describe, it, expect } from "bun:test"

/**
 * The link socket directory must exist inside the box.
 *
 * `Bun.spawn` exposes stdio only, so the agent cannot inherit a pre-connected
 * socket fd and must dial by path — which means punching one hole through an
 * otherwise deny-by-default filesystem. That hole is deliberate and worth
 * pinning: if it closes, a confined agent silently cannot reach its supervisor;
 * if it widens, the sandbox leaks.
 */
function spec(over: { policy?: Partial<CapsulePolicy>; control?: string[] } = {}) {
    return fromPolicy({
        policy: { process: { spawn: true, run: true }, ...over.policy } as CapsulePolicy,
        tier: "auto",
        cwd: "/agent",
        entrypoint: "/usr/lib/axon/agent.ts",
        runtime: ["/usr/bin/bun"],
        ...(over.control ? { control: over.control } : {}),
    })
}

describe("confinement — the link socket mount", () => {
    it("binds the socket directory read-write so the agent can connect", () => {
        // A unix socket connect needs write on the directory entry.
        const args = Bwrap(spec({ control: ["/run/axon/a1"] })).wrap(["bun", "run", "x"])
        const i = args.indexOf("/run/axon/a1")
        expect(i).toBeGreaterThan(-1)
        expect(args[i - 1]).toBe("--bind")
    })

    it("binds nothing extra when the supervisor asks for nothing", () => {
        expect(spec().control).toEqual([])
    })

    it("keeps supervisor plumbing OUT of the user's fs grants", () => {
        // `axon policy` renders what the USER allowed. A socket directory
        // appearing there would read as a grant they authored.
        const s = spec({ policy: { fs: { read: ["/agent/src"] } }, control: ["/run/axon/a1"] })
        expect(s.fs.read).toEqual(["/agent/src"])
        expect(s.fs.write).toEqual([])
        expect(s.control).toEqual(["/run/axon/a1"])
    })

    it("still hides everything the policy did not declare", () => {
        // The hole is one directory, not a relaxation of the wall.
        const args = Bwrap(spec({ policy: { fs: { read: ["/agent/src"] } }, control: ["/run/axon/a1"] })).wrap(["bun"])
        expect(args.join(" ")).not.toContain("/home")
        expect(args.join(" ")).not.toContain("/agent/secrets")
    })
})
