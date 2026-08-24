import { fromPolicy } from "../../platform/confine/spec"
import type { CapsulePolicy } from "../../types"

const base = {
    tier: "auto" as const,
    cwd: "/home/agent/project",
    entrypoint: "/rt/main.ts",
    runtime: ["/rt"],
}

const spec = (policy: CapsulePolicy["fs"] extends never ? never : Partial<CapsulePolicy>) =>
    fromPolicy({ ...base, policy: { process: { spawn: false, run: false }, ...policy } })

describe("fromPolicy normalization", () => {
    it("resolves relative fs paths against the capsule cwd", () => {
        const s = spec({ fs: { read: ["./workspace"], write: ["./out"] } })
        expect(s.fs.read).toEqual(["/home/agent/project/workspace"])
        expect(s.fs.write).toEqual(["/home/agent/project/out"])
    })

    it("leaves absolute fs paths untouched", () => {
        const s = spec({ fs: { read: ["/data"], write: [] } })
        expect(s.fs.read).toEqual(["/data"])
    })

    it("with no fs policy, binds cwd and works from it", () => {
        const s = spec({})
        expect(s.bindCwd).toBe(true)
        expect(s.workdir).toBe("/home/agent/project")
    })

    it("with an fs policy, does not bind cwd and works from the first write path", () => {
        const s = spec({ fs: { read: ["./ro"], write: ["./rw"] } })
        expect(s.bindCwd).toBe(false)
        expect(s.workdir).toBe("/home/agent/project/rw")
    })

    it("falls back to the first read path as workdir when fs is read-only", () => {
        const s = spec({ fs: { read: ["./ro"], write: [] } })
        expect(s.bindCwd).toBe(false)
        expect(s.workdir).toBe("/home/agent/project/ro")
    })

    it("maps network destinations to their host keys", () => {
        const s = spec({ network: { "api.github.com": true, "example.com": false } })
        expect(s.network.sort()).toEqual(["api.github.com", "example.com"])
    })

    it("carries limits through, null where unset", () => {
        const s = spec({ limits: { memory: "2G" } })
        expect(s.limits).toEqual({ memory: "2G", cpu: null, pids: null })
    })
})
