import { describe, expect, test } from "bun:test"
import { Space, fingerprint, type Axis } from "../../../src/pure"
import { AXES, grownSpace, testSpace } from "../../space"

const base: Axis = { name: "threat", domain: "risk", kind: "noul", question: "How dangerous is this?" }

describe("fingerprint", () => {
    test("is stable across builds of the same axis list", () => {
        expect(fingerprint(AXES)).toBe(fingerprint([...AXES]))
    })

    test("changes when an axis is added", () => {
        expect(grownSpace().version).not.toBe(testSpace().version)
    })

    test("changes when the QUESTION changes — same name, different meaning", () => {
        const reworded: Axis = { ...base, question: "Is this a threat to me specifically?" }
        expect(fingerprint([reworded])).not.toBe(fingerprint([base]))
    })

    test("changes when order changes — order is the column index", () => {
        const second: Axis = { name: "fragile", domain: "risk", kind: "noul", question: "Does this break easily?" }
        expect(fingerprint([base, second])).not.toBe(fingerprint([second, base]))
    })

    test("changes when levels change", () => {
        const two: Axis = { ...base, kind: "score", levels: ["none", "high"] }
        const three: Axis = { ...base, kind: "score", levels: ["none", "low", "high"] }
        expect(fingerprint([two])).not.toBe(fingerprint([three]))
    })

    test("does NOT change when weight or metric changes — those are query-time", () => {
        const heavy = Space({ axes: AXES, domains: { risk: { weight: 9, metric: "cosine" } } })
        expect(heavy.version).toBe(testSpace().version)
    })
})
