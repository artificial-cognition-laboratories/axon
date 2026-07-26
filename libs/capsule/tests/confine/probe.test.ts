import { probe, tierReady } from "../../platform/confine/probe"

/**
 * probe() reads the real host. These assert its reporting contract — shape and
 * never-throws — not specific host facts, so they pass on any machine (Linux
 * with tools, Linux without, or non-Linux).
 */
describe("probe", () => {
    it("returns a complete status record without throwing", () => {
        const s = probe()
        for (const key of ["isLinux", "bwrap", "systemd", "nft", "userExists", "auto", "hardened"] as const) {
            expect(typeof s[key]).toBe("boolean")
        }
    })

    it("is never available off Linux", () => {
        const s = probe()
        if (!s.isLinux) {
            expect(s.auto).toBe(false)
            expect(s.hardened).toBe(false)
        }
    })

    it("rootless auto needs only bwrap + systemd, no user or nft", () => {
        const s = probe()
        expect(s.auto).toBe(s.bwrap && s.systemd)
    })

    it("hardened additionally needs nft and the confinement user", () => {
        const s = probe()
        expect(s.hardened).toBe(s.auto && s.nft && s.userExists)
    })

    it("tierReady mirrors the tier flags", () => {
        const s = probe()
        expect(tierReady("auto", s)).toBe(s.auto)
        expect(tierReady("hardened", s)).toBe(s.hardened)
    })

    it("reports a missing user for a name that cannot exist", () => {
        expect(probe("no-such-user-xyz-000").userExists).toBe(false)
    })
})
