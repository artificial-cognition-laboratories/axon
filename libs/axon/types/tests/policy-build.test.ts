import { describe, expect, it } from "bun:test"
import { Policy } from "../src/policy-build"
import type { AxonBlueprint } from "../src/blueprint"

/**
 * Policy() is the single resolution seam that replaced two — the kernel's
 * ceiling intersection (kernel/src/capsule.ts) and the capsule Blueprint()'s
 * re-normalisation. Those two copies kept a wildcard literal in step with a
 * source-reading test; with one seam, that guard is gone and these take over.
 *
 * Pinned because a ceiling that silently stops applying is invisible until
 * someone audits it — there is no failing call to notice, only a permission
 * quietly granted.
 */
function blueprint(input: {
    policy?: Record<string, unknown>
    profilePolicy?: Record<string, unknown>
    root?: string
}): AxonBlueprint {
    return {
        config: { policy: input.policy },
        ...(input.profilePolicy ? { profilePolicy: input.profilePolicy } : {}),
        paths: { root: input.root ?? "/agent" },
    } as unknown as AxonBlueprint
}

describe("Policy — isolation default", () => {
    it("is 'none' when nothing declares containment intent", () => {
        // "I didn't set a security policy" means full access, no hassle.
        expect(Policy({ blueprint: blueprint({}), tools: [] }).isolation).toBe("none")
    })

    it.each([
        ["fs", { fs: { read: ["./src"] } }],
        ["net", { net: { allow: ["example.com"] } }],
        ["limits", { limits: { memory: "1G" } }],
        ["env", { env: { allow: ["GITHUB_TOKEN"] } }],
    ])("is 'auto' when %s declares containment intent", (_name, policy) => {
        expect(Policy({ blueprint: blueprint({ policy }), tools: [] }).isolation).toBe("auto")
    })

    it("honours an explicit tier over the inferred one", () => {
        const { isolation } = Policy({
            blueprint: blueprint({ policy: { isolation: "none", fs: { read: ["./src"] } } }),
            tools: [],
        })
        expect(isolation).toBe("none")
    })

    it("takes containment from the PROFILE even when the agent declares none", () => {
        // A profile declaring containment opts every agent on the machine in.
        const { isolation } = Policy({
            blueprint: blueprint({ profilePolicy: { fs: { read: ["/safe"] } } }),
            tools: [],
        })
        expect(isolation).toBe("auto")
    })
})

describe("Policy — the profile is a ceiling", () => {
    it("a bare profile deny is final regardless of the agent's grant", () => {
        const { policy } = Policy({
            blueprint: blueprint({
                profilePolicy: { shell: false },
                policy: { shell: { allow: ["git"], raw: true } },
            }),
            tools: [],
        })
        // The profile denied the whole surface: no program survives the
        // intersection, and `raw` is an AND so the agent cannot re-enable it.
        expect(policy.shell?.allow).toEqual([])
        expect(policy.shell?.raw).toBe(false)
    })

    it("a profile wildcard applies to every key, not only '*'", () => {
        // The leak this exists to prevent: profile `tools: "escalate"`
        // normalises to { "*": "escalate" }, the agent keeps its own `fs` key,
        // and an exact-match lookup then hands back `true` — the blanket never
        // consulted. A ceiling a named grant can punch through is no ceiling.
        const { policy } = Policy({
            blueprint: blueprint({
                profilePolicy: { tools: "escalate" },
                policy: { tools: { fs: true } },
            }),
            tools: ["fs"],
        })
        expect(policy.tools?.fs).toBe("escalate")
    })

    it("the profile's fs wins outright — bind mounts cannot intersect globs", () => {
        const { policy } = Policy({
            blueprint: blueprint({
                profilePolicy: { fs: { read: ["/safe"] } },
                policy: { fs: { read: ["/anywhere"] } },
            }),
            tools: [],
        })
        expect(policy.fs?.read).toEqual(["/safe"])
    })

    it("an agent may harden BEYOND its profile, never below it", () => {
        expect(Policy({
            blueprint: blueprint({ profilePolicy: { isolation: "auto" }, policy: { isolation: "hardened" } }),
            tools: [],
        }).isolation).toBe("hardened")

        expect(Policy({
            blueprint: blueprint({ profilePolicy: { isolation: "hardened" }, policy: { isolation: "none" } }),
            tools: [],
        }).isolation).toBe("hardened")
    })
})

describe("Policy — normalisation", () => {
    it("expands a bare surface rule to the wildcard key", () => {
        const { policy } = Policy({ blueprint: blueprint({ policy: { tools: "escalate" } }), tools: [] })
        expect(policy.tools?.["*"]).toBe("escalate")
    })

    it("expands a bare shell rule into the full block", () => {
        const { policy } = Policy({ blueprint: blueprint({ policy: { shell: false } }), tools: [] })
        expect(policy.shell?.allow).toEqual([])
        expect(policy.shell?.deny).toEqual(["*"])
        // Turning the surface off must turn the bypass off with it.
        expect(policy.shell?.raw).toBe(false)
    })

    it("grants no raw shell even when shell is enabled wholesale", () => {
        // `shell: true` is "let it run programs", not "hand it sh -c" — the
        // one switch that makes every other rule on this surface moot.
        const { policy } = Policy({ blueprint: blueprint({ policy: { shell: true } }), tools: [] })
        expect(policy.shell?.allow).toEqual(["*"])
        expect(policy.shell?.raw).toBe(false)
    })

    it("resolves fs paths against the AGENT ROOT, not the invocation cwd", () => {
        // `fs: { read: ["./workspace"] }` in agents/foo/axon.config.ts means
        // agents/foo/workspace, wherever axon was actually run from.
        const { policy } = Policy({
            blueprint: blueprint({ policy: { fs: { read: ["./workspace"] } }, root: "/agents/foo" }),
            tools: [],
        })
        expect(policy.fs?.read).toEqual(["/agents/foo/workspace"])
    })

    it("leaves an absolute fs path untouched", () => {
        const { policy } = Policy({
            blueprint: blueprint({ policy: { fs: { write: ["/tmp/out"] } }, root: "/agents/foo" }),
            tools: [],
        })
        expect(policy.fs?.write).toEqual(["/tmp/out"])
    })
})

describe("Policy — tool grants", () => {
    it("allows every installed tool namespace by default", () => {
        // Axon wires a box for its OWN blueprint, so the default posture is
        // allow-what-isn't-restricted — the opposite of the capsule
        // primitive's deny-by-default, which sandboxes foreign code.
        const { policy } = Policy({ blueprint: blueprint({}), tools: ["fs", "github"] })
        expect(policy.tools).toMatchObject({ fs: true, github: true })
    })

    it("lets the user's own rule win over the default grant", () => {
        const { policy } = Policy({
            blueprint: blueprint({ policy: { tools: { github: false } } }),
            tools: ["fs", "github"],
        })
        expect(policy.tools?.github).toBe(false)
        expect(policy.tools?.fs).toBe(true)
    })
})

describe("Policy — the container tier", () => {
    it("is never inferred, only declared", () => {
        // A runtime that quietly fell back to `container` when namespaces were
        // unavailable would turn a misconfigured host into a silent downgrade.
        // Containment intent with no explicit tier still means `auto`, which
        // then fails loudly if the box cannot be built.
        expect(Policy({
            blueprint: blueprint({ policy: { fs: { read: ["./src"] } } }),
            tools: [],
        }).isolation).toBe("auto")
    })

    it("is carried through when a deploy declares it", () => {
        expect(Policy({
            blueprint: blueprint({ policy: { isolation: "container", fs: { read: ["./src"] } } }),
            tools: [],
        }).isolation).toBe("container")
    })

    it("cannot satisfy a profile that demanded a real OS wall", () => {
        // `container` gives a strong TENANT boundary but no per-agent OS
        // enforcement of the user's own fs/network/limits. A profile asking for
        // `auto` must therefore out-rank it, so the agent gets `auto` and the
        // build fails loudly rather than running with less than was asked for.
        expect(Policy({
            blueprint: blueprint({
                profilePolicy: { isolation: "auto" },
                policy: { isolation: "container" },
            }),
            tools: [],
        }).isolation).toBe("auto")
    })

    it("out-ranks 'none' — a tenant boundary is more than no boundary", () => {
        expect(Policy({
            blueprint: blueprint({
                profilePolicy: { isolation: "container" },
                policy: { isolation: "none" },
            }),
            tools: [],
        }).isolation).toBe("container")
    })
})

describe("Policy — fs path resolution has no node:path", () => {
    /**
     * `types` imports no node builtin anywhere, deliberately: these contracts
     * are copied into the TUI's generated globals and reached by guest code
     * that cannot resolve a builtin at all. So the POSIX helpers are written
     * out, and these pin the cases where a hand-rolled joiner usually goes
     * wrong — a policy path is a bind mount, and a wrong one is a hole.
     */
    it("resolves a relative path against the agent root", () => {
        const { policy } = Policy({
            blueprint: blueprint({ policy: { fs: { read: ["./workspace"] } }, root: "/agents/foo" }),
            tools: [],
        })
        expect(policy.fs?.read).toEqual(["/agents/foo/workspace"])
    })

    it("collapses '.' segments", () => {
        const { policy } = Policy({
            blueprint: blueprint({ policy: { fs: { read: ["./a/./b"] } }, root: "/agents/foo" }),
            tools: [],
        })
        expect(policy.fs?.read).toEqual(["/agents/foo/a/b"])
    })

    it("resolves '..' rather than leaving it in the mount path", () => {
        // `/agent/workspace/../secrets` and `/agent/secrets` are the same
        // directory. A check comparing them as strings would be bypassed by
        // writing the first.
        const { policy } = Policy({
            blueprint: blueprint({ policy: { fs: { read: ["./workspace/../data"] } }, root: "/agents/foo" }),
            tools: [],
        })
        expect(policy.fs?.read).toEqual(["/agents/foo/data"])
    })

    it("never lets '..' climb above the root", () => {
        // A grant that escapes the project is a broken grant, and silently
        // letting it out is the one outcome a sandbox must not have.
        const { policy } = Policy({
            blueprint: blueprint({ policy: { fs: { read: ["../../../etc"] } }, root: "/agents/foo" }),
            tools: [],
        })
        expect(policy.fs?.read?.[0]?.startsWith("/etc")).toBe(true)
        expect(policy.fs?.read?.[0]).not.toContain("..")
    })

    it("leaves an absolute path untouched", () => {
        const { policy } = Policy({
            blueprint: blueprint({ policy: { fs: { write: ["/tmp/out"] } }, root: "/agents/foo" }),
            tools: [],
        })
        expect(policy.fs?.write).toEqual(["/tmp/out"])
    })
})
