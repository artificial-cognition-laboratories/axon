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
        // Every field is optional on both sides — a profile that declares
        // nothing has no opinion — so this direction is asserted per field.
        const profile: ProfilePolicy = {
            isolation: "auto",
            fs: { read: ["./data"], write: ["./out"] },
            net: { allow: ["api.example.com:443"], dns: "allowlist" },
            shell: { allow: ["bun"], raw: false, spawn: false },
            env: { allow: ["GITHUB_TOKEN"] },
            limits: { memory: "2G", cpu: "50%", pids: 64, disk: "1G", wall: "30m" },
            tools: { github: "escalate" },
        }

        const isolation: CapsulePolicy["isolation"] = profile.isolation
        const fs: CapsulePolicy["fs"] = profile.fs
        const net: CapsulePolicy["net"] = profile.net
        const env: CapsulePolicy["env"] = profile.env
        const limits: CapsulePolicy["limits"] = profile.limits
        const tools: CapsulePolicy["tools"] = profile.tools
        const shell: CapsulePolicy["shell"] = profile.shell

        expect({ isolation, fs, net, env, limits, tools, shell }).toBeDefined()
    })

    test("the capsule's own keys are all expressible by a profile", () => {
        // The direction that catches a NEW capability landing in CapsulePolicy
        // with no way for a profile to bound it — a ceiling with a hole in it.
        // No exclusions: every capsule key is now bounded by a profile one.
        type CapsuleKeys = keyof CapsulePolicy
        type ProfileKeys = keyof ProfilePolicy

        // `never` on both sides or this file stops compiling. Written as an
        // assignment TO never rather than a computed alias: an unused type
        // alias is erased and checks nothing, which is how a drift guard ends
        // up guarding nothing.
        const missing: never = null as unknown as Exclude<CapsuleKeys, ProfileKeys>
        const extra: never = null as unknown as Exclude<ProfileKeys, CapsuleKeys>

        expect([missing, extra]).toBeDefined()
    })
})
