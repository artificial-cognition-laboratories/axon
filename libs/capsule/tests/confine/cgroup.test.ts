import { Cgroup } from "../../platform/confine/cgroup"
import type { ConfinementSpec } from "../../platform/confine/spec"

type Limits = ConfinementSpec["limits"]
type Arg = Pick<ConfinementSpec, "tier" | "limits">
const limits = (over: Partial<Limits> = {}): Limits => ({ memory: null, cpu: null, pids: null, ...over })
const auto = (over: Partial<Limits> = {}): Arg => ({ tier: "auto", limits: limits(over) })
const line = (a: string[]) => a.join(" ")

describe("Cgroup argv", () => {
    it("runs a transient, self-collecting systemd scope", () => {
        const a = Cgroup(auto()).args()
        expect(a).toContain("systemd-run")
        expect(a).toContain("--scope")
        expect(a).toContain("--collect")
    })

    it("uses a rootless --user scope for the auto tier", () => {
        expect(Cgroup(auto()).args()).toContain("--user")
    })

    it("uses a privileged system scope for the hardened tier", () => {
        expect(Cgroup({ tier: "hardened", limits: limits() }).args()).not.toContain("--user")
    })

    it("maps memory to MemoryMax", () => {
        expect(line(Cgroup(auto({ memory: "2G" })).args())).toContain("MemoryMax=2G")
    })

    it("maps cpu to CPUQuota", () => {
        expect(line(Cgroup(auto({ cpu: "50%" })).args())).toContain("CPUQuota=50%")
    })

    it("maps pids to TasksMax", () => {
        expect(line(Cgroup(auto({ pids: 256 })).args())).toContain("TasksMax=256")
    })

    it("omits a limit left unset rather than passing a default", () => {
        const l = line(Cgroup(auto({ memory: "1G" })).args())
        expect(l).toContain("MemoryMax=1G")
        expect(l).not.toContain("CPUQuota")
        expect(l).not.toContain("TasksMax")
    })

    it("wrap() prefixes the scope before the inner command", () => {
        const cmd = Cgroup(auto({ pids: 8 })).wrap(["bwrap", "--", "bun"])
        expect(cmd[0]).toBe("systemd-run")
        expect(cmd.slice(-3)).toEqual(["bwrap", "--", "bun"])
    })
})
