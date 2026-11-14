import { describe, expect, it } from "bun:test"
import { examples, manifest } from "../../src"

/** A copy of an example body to break one thing in. */
function broken(from: object, change: (body: any) => void): unknown {
    const copy = structuredClone(from) as any
    change(copy)
    return copy
}

describe("manifest.check", () => {
    it("accepts every example body — games, a shell, robots, a rover, a drone, a creature, an arm, a car, a house", () => {
        expect(Object.keys(examples).length).toBe(11)
        for (const [name, body] of Object.entries(examples)) expect(() => manifest.check(body), name).not.toThrow()
    })

    it("refuses a contract it does not speak, by name", () => {
        expect(() => manifest.check(broken(examples.MINECRAFT, body => { body.contract = "axon.body/2" }))).toThrow("the body speaks axon.body/2")
    })

    it("names the first thing wrong by its path", () => {
        expect(() => manifest.check(broken(examples.MINECRAFT, body => { delete body.senses[0].components[2].unit }))).toThrow("manifest.senses[0].components[2].unit is missing")
        expect(() => manifest.check(broken(examples.MINECRAFT, body => { body.frames[3].parent = "tail" }))).toThrow("manifest.frames[3].parent names no frame")
        expect(() => manifest.check(broken(examples.MINECRAFT, body => { body.frames[0].turn = [0, 0, 0, 2] }))).toThrow("manifest.frames[0].turn is not of length one")
        expect(() => manifest.check(broken(examples.MINECRAFT, body => { body.controls[2].components[0].joint = "tail" }))).toThrow("names no drivable joint")
        expect(() => manifest.check(broken(examples.MINECRAFT, body => { body.senses.push({ ...body.senses[0] }) }))).toThrow(`repeats the sense channel "/imu"`)
    })

    it("refuses frames that are not a tree", () => {
        expect(() => manifest.check(broken(examples.MINECRAFT, body => { body.frames[1].parent = "eye" }))).toThrow("loops back")
        expect(() => manifest.check(broken(examples.MINECRAFT, body => { body.frames[1].parent = null }))).toThrow("exactly one is the body's base")
    })

    it("refuses a control that keeps what runs away left applied", () => {
        expect(() => manifest.check(broken(examples.TURTLEBOT, body => { body.controls[0].lapse = { kind: "keep" } }))).toThrow("keeps linear.x, a velocity — left applied it runs away")
        expect(() => manifest.check(broken(examples.DRONE, body => { delete body.controls[0].lapse.after }))).toThrow("lapse.after is missing")
    })

    it("refuses a clock that cannot keep its pace", () => {
        expect(() => manifest.check(broken(examples.CREATURE, body => { delete body.clock.step }))).toThrow("is stepped, but the clock has no step")
    })

    it("holds places and frames apart, and senses read in either", () => {
        expect(() => manifest.check(broken(examples.DRONE, body => { body.frames[5].name = "earth"; body.senses[7].frame = "earth" }))).toThrow("is also a place's name")
        expect(() => manifest.check(broken(examples.DRONE, body => { body.senses[1].frame = "mars" }))).toThrow("names no frame or place")
    })

    it("refuses a body of no space that has anywhere to be", () => {
        expect(() => manifest.check(broken(examples.SHELL, body => { body.frames.push({ name: "arm", parent: "base", axes: "flu", at: [0, 0, 0], turn: [0, 0, 0, 1] }) }))).toThrow("more than the base")
        expect(() => manifest.check(broken(examples.SHELL, body => { body.world.gravity = 9.81 }))).toThrow("in no space")
    })

    it("refuses a category with nothing to choose, and a choice of no categories", () => {
        expect(() => manifest.check(broken(examples.CAR, body => { delete body.controls[1].components[0].categories }))).toThrow("is category, but there are no categories")
        expect(() => manifest.check(broken(examples.CAR, body => { body.controls[0].components[1].interface = "choice" }))).toThrow("is a choice of no categories")
        expect(() => manifest.check(broken(examples.DRONE, body => { body.senses[5].components[0].unit = "count" }))).toThrow("has categories, but is not category")
    })

    it("refuses driving a joint that only mimics another", () => {
        expect(() => manifest.check(broken(examples.ARM, body => { body.controls[1].components[0].joint = "panda_rightfinger" }))).toThrow("names no drivable joint")
        expect(() => manifest.check(broken(examples.ARM, body => { body.frames.at(-2).joint.mimic.joint = "panda_hand" }))).toThrow("names no jointed frame")
    })

    it("checks a picture's lens and what its pixels measure", () => {
        expect(() => manifest.check(broken(examples.ROVER, body => { body.senses[4].lens.distortion.coefficients.pop() }))).toThrow("is not 5 numbers")
        expect(() => manifest.check(broken(examples.CAR, body => { body.senses[4].lens.elevation.pop() }))).toThrow("is not 32 numbers")
        expect(() => manifest.check(broken(examples.TERRARIA, body => { body.senses[2].pixel = { kind: "depth", range: 10 } }))).toThrow("has no axis to measure along")
        expect(() => manifest.check(broken(examples.MINECRAFT, body => { body.senses[4].lens.centre = [2000, 360] }))).toThrow("is off the picture")
    })

    it("asks a structured sense for its schema, and only a structured one", () => {
        expect(() => manifest.check(broken(examples.MINECRAFT, body => { delete body.senses[7].schema }))).toThrow("schema is missing")
        expect(() => manifest.check(broken(examples.SHELL, body => { body.senses[0].schema = {} }))).toThrow("is for a sense whose format is json")
    })
})
