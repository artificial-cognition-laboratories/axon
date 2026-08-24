import { Capsule } from "@axon/capsule"
import { isAxonError } from "@arcforge/err"
import { probe } from "../../platform/confine/probe"

const isLinux = process.platform === "linux"
const status = probe()
const boxed = status.auto ? it : it.skip

describe("Confinement — boot posture", () => {
    it("boots unconfined with isolation:none and no host dependency", async () => {
        const capsule = Capsule({ policy: { isolation: "none", process: { spawn: false, run: true } } })
        await capsule.boot()
        expect(await capsule.run("1 + 1")).toBe(2)
        await capsule.shutdown()
    })

    // On Linux without the primitives, isolation:auto must refuse to boot rather
    // than silently degrade to an unconfined process (Hard Invariant #1/#6).
    const failLoud = isLinux && !status.auto ? it : it.skip
    failLoud("fails loud on isolation:auto when confinement is unavailable", async () => {
        const capsule = Capsule({ policy: { isolation: "auto", process: { spawn: false, run: true } } })
        await expect(capsule.boot()).rejects.toThrow("Confinement Unavailable")
    })

    // Hardened is opt-in and privileged; if the host isn't provisioned for it,
    // it too must fail loud rather than fall back to a weaker tier.
    const noHardened = isLinux && !status.hardened ? it : it.skip
    noHardened("fails loud on isolation:hardened when the host is not provisioned", async () => {
        const capsule = Capsule({ policy: { isolation: "hardened", process: { spawn: false, run: true } } })
        await expect(capsule.boot()).rejects.toThrow("Confinement Unavailable")
    })

    boxed("boots confined rootless with isolation:auto", async () => {
        const capsule = Capsule({ policy: { isolation: "auto", process: { spawn: false, run: true } } })
        await capsule.boot()
        expect(await capsule.run("1 + 1")).toBe(2)
        await capsule.shutdown()
    })

    // A boot failure must be a CODED err() carrying the subprocess stderr — never
    // a raw Error that surfaces as AX-UNKNOWN. An fs path that does not exist
    // makes bwrap fail, which crashes the subprocess before ready.
    boxed("surfaces a coded error (not AX-UNKNOWN) when the box cannot start", async () => {
        const capsule = Capsule({
            policy: {
                isolation: "auto",
                fs: { read: ["/nonexistent-confine-path-xyz"], write: [] },
                process: { spawn: false, run: true },
            },
        })
        let caught: unknown
        try {
            await capsule.boot()
        } catch (e) {
            caught = e
        }
        expect(isAxonError(caught)).toBe(true)
        expect((caught as { code: string }).code).not.toBe("AX-UNKNOWN-001")
        expect((caught as { code: string }).code).toBe("AX-CAPSULE-006")
    })
})
