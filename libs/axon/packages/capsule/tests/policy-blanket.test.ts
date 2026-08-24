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

    it("expands a bare network rule the same way", () => {
        const blueprint = Blueprint({ policy: { network: false } })
        expect(blueprint.policy.network).toEqual({ [POLICY_WILDCARD]: false })
    })

    it("applies a bare process rule to BOTH verbs, not to a wildcard key", () => {
        // `process` is a fixed pair, not an open bucket — there is no third
        // verb a wildcard could ever match.
        const blueprint = Blueprint({ policy: { process: "escalate" } })
        expect(blueprint.policy.process).toEqual({ spawn: "escalate", run: "escalate" })
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

    it("defaults process to deny when nothing is authored", () => {
        expect(Blueprint({}).policy.process).toEqual({ spawn: false, run: false })
    })
})
