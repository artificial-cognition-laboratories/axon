import { describe, expect, test } from "bun:test"
import { Axes } from "../../../src/pure"
import { AXES, testSpace } from "../../space"

describe("Axes", () => {
    test("index maps a name to its column", () => {
        const axes = Axes({ axes: AXES })
        expect(axes.index("threat")).toBe(0)
        expect(axes.index("interactive")).toBe(4)
    })

    test("an unknown axis throws rather than returning -1", () => {
        const axes = Axes({ axes: AXES })
        expect(() => axes.index("nope")).toThrow(/Unknown Axis|nope/)
    })

    test("a duplicate name throws — a name is also a column index", () => {
        expect(() =>
            Axes({
                axes: [
                    { name: "threat", domain: "risk", kind: "noul", question: "a" },
                    { name: "threat", domain: "risk", kind: "noul", question: "b" },
                ],
            })
        ).toThrow(/Duplicate Axis|threat/)
    })
})

describe("Domains", () => {
    test("domains are derived from the axes that declare them", () => {
        const space = testSpace()
        expect(space.domains.names().sort()).toEqual(["form", "risk", "use"])
    })

    test("overrides tune weight and metric, defaults fill the rest", () => {
        const space = testSpace()
        expect(space.domains.get("risk")).toEqual({ name: "risk", weight: 2, metric: "euclidean" })
        expect(space.domains.get("form")).toEqual({ name: "form", weight: 1, metric: "cosine" })
        expect(space.domains.get("use")).toEqual({ name: "use", weight: 1, metric: "euclidean" })
    })

    test("axesOf returns the columns in table order", () => {
        const space = testSpace()
        expect([...space.domains.axesOf("risk")]).toEqual([0, 1])
        expect([...space.domains.axesOf("form")]).toEqual([2, 3])
    })

    test("an unknown domain throws", () => {
        const space = testSpace()
        expect(() => space.domains.get("mood")).toThrow(/Unknown Domain|mood/)
    })
})
