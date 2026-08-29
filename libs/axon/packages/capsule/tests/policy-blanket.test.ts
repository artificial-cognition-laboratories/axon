import { Blueprint, POLICY_WILDCARD } from "../src/blueprint"

/**
 * One rule for a whole enforcement surface.
 *
 * Keyed alone, "escalate every tool" had to be written as one entry per
 * installed module — a list that is complete the day it is written and
 * silently stale the moment anything else is installed. That is the failure
 * mode worth fixing: a policy that LOOKS complete and is not.
 *
 * Normalised at this seam so the mediator reads one shape on every call.
 */
describe("policy: a blanket rule on a surface", () => {
    it("expands a bare tools rule to the wildcard key", () => {
        const blueprint = Blueprint({ policy: { tools: "escalate" } })
        expect(blueprint.policy.tools).toEqual({ [POLICY_WILDCARD]: "escalate" })
    })

    it("carries a net policy through as authored — there is no bare form", () => {
        // `net` deliberately has NO blanket rule and no per-host verdicts. It
        // compiles to nftables, which matches addresses and cannot escalate, so
        // a shape expressing more than the kernel does is how `{ "*": false }`
        // came to mean unrestricted internet. An allow/deny list is the whole
        // vocabulary, and it passes through unchanged.
        const blueprint = Blueprint({ policy: { net: { allow: ["api.github.com:443"] } } })
        expect(blueprint.policy.net).toEqual({ allow: ["api.github.com:443"] })
    })

    it("absent net means no network at all, not an empty allowlist", () => {
        expect(Blueprint({}).policy.net).toBeUndefined()
    })

    it("expands a bare shell rule into the full block, not a wildcard key", () => {
        // `shell` is a fixed surface, not an open bucket — there is no
        // verb a wildcard could ever match.
        const blueprint = Blueprint({ policy: { shell: true } })
        expect(blueprint.policy.shell?.allow).toEqual(["*"])
        // Enabling the surface must NOT hand over a raw shell — that is the one
        // switch which makes every other rule on this surface unenforceable.
        expect(blueprint.policy.shell?.raw).toBe(false)
    })

    it("leaves the keyed form exactly as authored", () => {
        const blueprint = Blueprint({ policy: { tools: { fs: true, http: false } } })
        expect(blueprint.policy.tools).toEqual({ fs: true, http: false })
    })

    it("keeps a glob rule whole rather than reading it as a bucket", () => {
        // `{ allow: [...] }` is a RULE, not a bucket keyed by a module called
        // "allow" — the vocabulary is what distinguishes them.
        const rule = { allow: ["read"], deny: ["write"] }
        const blueprint = Blueprint({ policy: { tools: rule } })
        expect(blueprint.policy.tools).toEqual({ [POLICY_WILDCARD]: rule })
    })

    it("lets a named key sit beside an authored wildcard", () => {
        const blueprint = Blueprint({ policy: { tools: { "*": "escalate", fs: true } } })
        expect(blueprint.policy.tools).toEqual({ "*": "escalate", fs: true })
    })

    it("leaves shell undeclared when nothing is authored", () => {
        // Undeclared is "no opinion", which the capsule's own default-deny then
        // answers. Distinct from `shell: false`, which is an authored denial.
        expect(Blueprint({}).policy.shell).toBeUndefined()
    })
})
