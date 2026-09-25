import { describe, expect, it } from "bun:test"
import { assertNetworkConfinement } from "../../src/confined"
import type { ProbeStatus } from "../../src/confine"
import type { CapsulePolicy } from "@arcforge/types"

const ready: ProbeStatus = {
    isLinux: true,
    bwrap: true,
    systemd: true,
    nft: true,
    slirp: true,
    capsh: true,
    network: true,
    userExists: true,
    auto: true,
    hardened: true,
}

const networkPolicy = { net: { allow: ["api.example.com:443"] } } as CapsulePolicy

describe("network policy host contract", () => {
    it("fails closed with an Axon error that names every missing prerequisite", () => {
        try {
            assertNetworkConfinement(networkPolicy, "auto", {
                ...ready,
                nft: false,
                slirp: false,
                capsh: false,
                network: false,
            })
            throw new Error("expected network confinement validation to fail")
        } catch (error) {
            expect(error).toMatchObject({
                code: "AX-CAPSULE-011",
                title: "Network Confinement Unavailable",
                context: {
                    tier: "auto",
                    missing: ["nftables (nft)", "slirp4netns", "libcap (capsh)"],
                },
            })
            expect((error as Error).message).toContain("slirp4netns")
        }
    })

    it("rejects an explicit unconfined tier instead of silently ignoring net", () => {
        expect(() => assertNetworkConfinement(networkPolicy, "none", ready)).toThrow(
            /net.*cannot be enforced.*isolation: "none"/i,
        )
    })

    it("allows an enforceable auto policy and a declared container boundary", () => {
        expect(() => assertNetworkConfinement(networkPolicy, "auto", ready)).not.toThrow()
        expect(() => assertNetworkConfinement(networkPolicy, "container", {
            ...ready,
            isLinux: false,
            bwrap: false,
            systemd: false,
            nft: false,
            slirp: false,
            capsh: false,
            network: false,
        })).not.toThrow()
    })
})
