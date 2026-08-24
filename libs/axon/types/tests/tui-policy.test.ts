import { describe, expect, test } from "bun:test"
import type { CapsulePolicy, PolicyRule } from "../src/policy"
import type { ProfilePolicy, ProfilePolicyRule } from "../src/tui"

/**
 * The profile-facing policy types are a DUPLICATE, and this is what keeps the
 * duplicate honest.
 *
 * `tui.ts` is copied verbatim into every profile's `.axon/types/` as ambient
 * globals, so it must not import — a profile directory has no node_modules for
 * an import to resolve through. That forces `ProfilePolicy` to restate the
 * shape rather than reference `CapsulePolicy`.
 *
 * The failure mode is silent and expensive: a rule shape a profile can WRITE
 * but the resolver cannot READ typechecks fine and then quietly enforces
 * nothing. The assignments below are compile-time assertions — if either type
 * gains a field the other lacks, this file stops compiling, which is the
 * loudest available signal short of a runtime check that cannot exist for
 * types.
 */

describe("the profile policy contract matches the capsule's", () => {
    test("every rule a profile can write is a rule the resolver accepts", () => {
        // Assignable in BOTH directions — one-way would let the profile type
        // drift narrower (a shape users cannot express) or wider (a shape
        // nothing enforces) without complaint.
        const asCapsule: PolicyRule = null as unknown as ProfilePolicyRule
        const asProfile: ProfilePolicyRule = null as unknown as PolicyRule

        expect(asCapsule).toBe(asProfile)
    })

    test("a profile policy is a valid capsule policy", () => {
        // `process` is optional on the profile side and required on the
        // capsule's — a profile that declares no shell rule has no opinion,
        // while a capsule always has one. So this direction is asserted per
        // field rather than wholesale.
        const profile: ProfilePolicy = {
            isolation: "auto",
            fs: { read: ["./data"], write: ["./out"] },
            network: { "api.example.com:443": true },
            process: { run: { allow: ["bun *"] }, spawn: false },
            limits: { memory: "2G", cpu: "50%", pids: 64 },
            tools: { github: "escalate" },
        }

        const isolation: CapsulePolicy["isolation"] = profile.isolation
        const fs: CapsulePolicy["fs"] = profile.fs
        const network: CapsulePolicy["network"] = profile.network
        const limits: CapsulePolicy["limits"] = profile.limits
        const tools: CapsulePolicy["tools"] = profile.tools
        const run: CapsulePolicy["process"]["run"] | undefined = profile.process?.run
        const spawn: CapsulePolicy["process"]["spawn"] | undefined = profile.process?.spawn

        expect({ isolation, fs, network, limits, tools, run, spawn }).toBeDefined()
    })

    test("the capsule's own keys are all expressible by a profile", () => {
        // The direction that catches a NEW capability landing in CapsulePolicy
        // with no way for a profile to bound it — a ceiling with a hole in it.
        // `process` is exempt for the optionality reason above.
        type CapsuleKeys = Exclude<keyof CapsulePolicy, "process">
        type ProfileKeys = Exclude<keyof ProfilePolicy, "process">

        // `never` on both sides or this file stops compiling. Written as an
        // assignment TO never rather than a computed alias: an unused type
        // alias is erased and checks nothing, which is how a drift guard ends
        // up guarding nothing.
        const missing: never = null as unknown as Exclude<CapsuleKeys, ProfileKeys>
        const extra: never = null as unknown as Exclude<ProfileKeys, CapsuleKeys>

        expect([missing, extra]).toBeDefined()
    })
})
