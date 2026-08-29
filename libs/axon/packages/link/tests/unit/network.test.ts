import { describe, expect, it } from "bun:test"
import { hostsFile, nftScript, parseDestination, resolveNetwork } from "../../src/confine/network"
import type { NetworkSpec } from "../../src/confine/spec"

/**
 * The egress ruleset, asserted as a VALUE.
 *
 * `nftScript` generates the text the entire network wall depends on, and until
 * now nothing checked its shape — the only coverage was end-to-end tests that
 * take a minute each and need Linux. A rule silently emitted in the wrong order
 * (an allow before a deny) or with the wrong default policy would still produce
 * a ruleset nft accepts, and only a live probe would notice.
 */

const spec = (over: Partial<NetworkSpec> = {}): NetworkSpec => ({
    allow: [{ address: "20.26.156.210", port: 443, host: "api.github.com" }],
    deny: [],
    dns: "allowlist",
    unresolved: [],
    ...over,
})

describe("parsing a destination", () => {
    it("splits host and port", () => {
        expect(parseDestination("api.github.com:443")).toEqual({ host: "api.github.com", port: 443 })
    })

    it("treats a bare host as every port", () => {
        expect(parseDestination("api.github.com")).toEqual({ host: "api.github.com" })
    })

    it("keeps a CIDR whole", () => {
        expect(parseDestination("10.0.0.0/8")).toEqual({ host: "10.0.0.0/8" })
    })

    it("does not read an IPv6 address's colons as a port", () => {
        // `::1` has more colons than a port separator, and reading the last one
        // as a port would silently narrow a grant to a nonsense port number.
        expect(parseDestination("[::1]:443")).toEqual({ host: "::1", port: 443 })
        expect(parseDestination("2001:db8::1")).toEqual({ host: "2001:db8::1" })
    })
})

describe("the generated nft ruleset", () => {
    it("defaults to DROP, so it is an allowlist by construction", () => {
        // Not by remembering to append a final deny — a ruleset that failed to
        // emit its last rule would then permit everything.
        expect(nftScript(spec())).toContain("policy drop")
    })

    it("accepts established traffic, or every allowed connection dies on its first response", () => {
        expect(nftScript(spec())).toContain("ct state established,related accept")
    })

    it("accepts loopback so the agent can reach its own supervisor socket", () => {
        expect(nftScript(spec())).toContain("oifname lo accept")
    })

    it("emits deny rules BEFORE allow rules", () => {
        const script = nftScript(spec({ deny: [{ address: "1.1.1.1" }] }))
        // nft evaluates in order, so an allow placed first would win. This is
        // the ordering that makes `deny beats allow` true in the kernel rather
        // than only in the resolver.
        expect(script.indexOf("1.1.1.1 drop")).toBeLessThan(script.indexOf("20.26.156.210"))
    })

    it("binds a port when the policy named one", () => {
        expect(nftScript(spec())).toContain("ip daddr 20.26.156.210 tcp dport 443 accept")
    })

    it("matches every port when the policy named a bare host", () => {
        const script = nftScript(spec({ allow: [{ address: "20.26.156.210" }] }))
        // The DNS rules legitimately carry `dport`, so the assertion is about
        // THIS destination's rule rather than the script as a whole.
        expect(script).toContain("ip daddr 20.26.156.210 accept")
        expect(script).not.toContain("20.26.156.210 tcp dport")
    })

    it("uses the ip6 family for an IPv6 destination", () => {
        expect(nftScript(spec({ allow: [{ address: "2001:db8::1" }] }))).toContain("ip6 daddr")
    })

    it("opens DNS unless the policy turned it off", () => {
        expect(nftScript(spec({ dns: "allowlist" }))).toContain("dport 53 accept")
        expect(nftScript(spec({ dns: "open" }))).toContain("dport 53 accept")
        expect(nftScript(spec({ dns: "off" }))).not.toContain("dport 53")
    })
})

describe("resolving a net policy", () => {
    it("is null when no policy is declared — no stack at all, not an empty allowlist", async () => {
        expect(await resolveNetwork(undefined)).toBeNull()
    })

    it("is null for an allowlist that names nothing", async () => {
        expect(await resolveNetwork({ allow: [] })).toBeNull()
    })

    it("takes a literal address as written, without resolving it", async () => {
        const resolved = await resolveNetwork({ allow: ["10.0.0.1:8080"] })
        expect(resolved?.allow).toEqual([{ address: "10.0.0.1", port: 8080 }])
    })

    it("REPORTS a name that did not resolve rather than dropping it", async () => {
        // A grant that quietly became no rule is a permission the user believes
        // they made and did not. The caller turns this into a boot error.
        const resolved = await resolveNetwork({ allow: ["nope.invalid:443"] })
        expect(resolved?.unresolved).toContain("nope.invalid:443")
    })

    it("defaults dns to allowlist, the narrower of the two working modes", async () => {
        expect((await resolveNetwork({ allow: ["10.0.0.1"] }))?.dns).toBe("allowlist")
    })
})

describe("the generated hosts file", () => {
    it("names only granted hosts, so nothing else can be looked up", () => {
        const file = hostsFile(spec())
        expect(file).toContain("20.26.156.210 api.github.com")
        expect(file).toContain("127.0.0.1 localhost")
        expect(file.split("\n").filter(l => l.includes("."))).toHaveLength(2)
    })

    it("omits an entry with no hostname — a literal address has no name to map", () => {
        expect(hostsFile(spec({ allow: [{ address: "10.0.0.1" }] }))).not.toContain("10.0.0.1 ")
    })
})
