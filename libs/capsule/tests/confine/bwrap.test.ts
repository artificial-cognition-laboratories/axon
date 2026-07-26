import { Bwrap } from "../../platform/confine/bwrap"
import type { ConfinementSpec } from "../../platform/confine/spec"

function spec(over: Partial<ConfinementSpec> = {}): ConfinementSpec {
    return {
        tier: "auto",
        user: null,
        uid: null,
        gid: null,
        workdir: "/work/project",
        bindCwd: true,
        cwd: "/work/project",
        entrypoint: "/rt/main.ts",
        runtime: [],
        fs: { read: [], write: [] },
        network: [],
        limits: { memory: null, cpu: null, pids: null },
        ...over,
    }
}

/** Join argv to a string so a flag+operand pair can be asserted as one unit. */
const line = (a: string[]) => a.join(" ")

describe("Bwrap argv", () => {
    it("does not drop uid in the rootless auto tier", () => {
        const a = Bwrap(spec({ tier: "auto" })).args()
        expect(a).not.toContain("--unshare-user")
        expect(line(a)).not.toContain("--uid")
    })

    it("drops to the spec uid/gid inside a user namespace on the hardened tier", () => {
        const a = Bwrap(spec({ tier: "hardened", user: "axon-agent", uid: 999, gid: 999 })).args()
        expect(a).toContain("--unshare-user")
        expect(line(a)).toContain("--uid 999")
        expect(line(a)).toContain("--gid 999")
    })

    it("isolates pid, ipc and uts namespaces", () => {
        const a = Bwrap(spec()).args()
        expect(a).toContain("--unshare-pid")
        expect(a).toContain("--unshare-ipc")
        expect(a).toContain("--unshare-uts")
    })

    it("closes the network when no destinations are declared", () => {
        expect(Bwrap(spec({ network: [] })).args()).toContain("--unshare-net")
    })

    it("keeps the network when a destination is declared", () => {
        expect(Bwrap(spec({ network: ["api.github.com:443"] })).args()).not.toContain("--unshare-net")
    })

    it("auto-binds the cwd read-write when no fs policy is declared", () => {
        const l = line(Bwrap(spec({ bindCwd: true, cwd: "/work/project", workdir: "/work/project" })).args())
        expect(l).toContain("--bind /work/project /work/project")
        expect(l).toContain("--chdir /work/project")
    })

    it("does NOT bind cwd when an fs policy is declared (policy is authoritative)", () => {
        // The over-grant guard: with fs declared, cwd must not be bound or a
        // sibling like /work/project/secret would leak despite the policy.
        const l = line(Bwrap(spec({
            bindCwd: false,
            cwd: "/work/project",
            workdir: "/work/project/allowed",
            fs: { read: [], write: ["/work/project/allowed"] },
        })).args())
        expect(l).not.toContain("--bind /work/project /work/project")
        expect(l).toContain("--bind /work/project/allowed /work/project/allowed")
        expect(l).toContain("--chdir /work/project/allowed")
    })

    it("binds declared read paths read-only and write paths read-write", () => {
        const l = line(Bwrap(spec({ bindCwd: false, fs: { read: ["/data"], write: ["/out"] } })).args())
        expect(l).toContain("--ro-bind /data /data")
        expect(l).toContain("--bind /out /out")
    })

    it("does not bind any path outside cwd and declared grants", () => {
        const l = line(Bwrap(spec()).args())
        expect(l).not.toContain("/home")
        expect(l).not.toContain("/etc/shadow")
    })

    it("wrap() prefixes bwrap and separates the inner command with --", () => {
        const cmd = Bwrap(spec()).wrap(["bun", "run", "/rt/main.ts"])
        expect(cmd[0]).toBe("bwrap")
        const sep = cmd.indexOf("--")
        expect(sep).toBeGreaterThan(0)
        expect(cmd.slice(sep + 1)).toEqual(["bun", "run", "/rt/main.ts"])
    })
})
