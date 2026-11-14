import { describe, expect, test } from "bun:test"
import { address } from "../../src/address"

describe("the full form", () => {
    test("a lab and a world is the least an address says", () => {
        expect(address.parse("world://localhost/atrium/kitchen")).toEqual({
            host: "localhost",
            lab: "atrium",
            world: "kitchen",
            scenario: null,
            body: null,
            identity: null,
        })
    })

    test("the third segment is a scenario — what makes an address a run", () => {
        const connection = address.parse("world://localhost/atrium/kitchen/reach-the-door")
        expect(connection.world).toBe("kitchen")
        expect(connection.scenario).toBe("reach-the-door")
    })

    test("body and identity are asked for in the query, not named in the place", () => {
        const connection = address.parse("world://localhost/atrium/kitchen?body=go2&as=Terry")
        expect(connection.body).toBe("go2")
        expect(connection.identity).toBe("Terry")
        expect(connection.scenario).toBeNull()
    })

    test("a lab alone is whatever that lab already runs — the shorthand, said in full", () => {
        const connection = address.parse("world://localhost/atrium?body=go2")
        expect(connection.world).toBeNull()
        expect(connection.body).toBe("go2")
    })

    test("a port is kept — the daemon it names, once labs are reachable over one", () => {
        expect(address.parse("world://127.0.0.1:1341/atrium/kitchen").host).toBe("127.0.0.1:1341")
    })
})

describe("the shorthand", () => {
    test("a lab alone, for a lab whose bodies are all one kind", () => {
        expect(address.parse("minecraft")).toEqual({
            host: "localhost",
            lab: "minecraft",
            world: null,
            scenario: null,
            body: null,
            identity: null,
        })
    })

    test("a lab and a body — the old AXON_BODY, with no world to start", () => {
        const connection = address.parse("atrium/go2")
        expect(connection.lab).toBe("atrium")
        expect(connection.body).toBe("go2")
        expect(connection.world).toBeNull()
    })
})

describe("what is refused", () => {
    const refused: Array<[string, string]> = [
        ["", "an empty address says nowhere"],
        ["world://localhost/atrium/kitchen/reach/again", "four segments is not a place"],
        ["http://localhost/atrium/kitchen", "another scheme is not a world address"],
        ["world://localhost/atrium/kitchen?character=Terry", "a query key that is not carried is a typo, not a no-op"],
        ["world://localhost/atrium/-kitchen", "a name must begin with a letter or a digit"],
        ["atrium/go2/kitchen", "the shorthand has no third part"],
    ]
    for (const [said, why] of refused) {
        test(why, () => {
            expect(() => address.parse(said)).toThrow()
        })
    }

    test("a lab on another machine is refused, not quietly served from here", () => {
        expect(() => address.parse("world://example.com/atrium/kitchen")).toThrow(/not this machine/)
    })
})

describe("written back", () => {
    const canonical = [
        "world://localhost/atrium/kitchen",
        "world://localhost/atrium/kitchen/reach-the-door",
        "world://localhost/atrium/kitchen?body=go2&as=Terry",
        "world://127.0.0.1:1341/minecraft/osnea?body=steve",
    ]
    for (const said of canonical) {
        test(said, () => {
            expect(address.format(address.parse(said))).toBe(said)
        })
    }

    test("the shorthand writes back as the full address it means, and parses again", () => {
        const written = address.format(address.parse("atrium/go2"))
        expect(written).toBe("world://localhost/atrium?body=go2")
        expect(address.parse(written)).toEqual(address.parse("atrium/go2"))
    })
})

/**
 * World names are not identifiers — `Cave Wars` is an ordinary Minecraft
 * save. An address that could not carry one would be an address for only
 * some of the worlds.
 */
describe("names with spaces in them", () => {
    test("a space is carried, escaped on the way out and read back on the way in", () => {
        const written = address.format(address.parse("minecraft/steve"))
        expect(written).toBe("world://localhost/minecraft?body=steve")

        const connection = address.parse("world://localhost/minecraft/Cave%20Wars")
        expect(connection.world).toBe("Cave Wars")
        expect(address.format(connection)).toBe("world://localhost/minecraft/Cave%20Wars")
    })

    test("a name written with a real space still parses — URL tolerates it in a path", () => {
        expect(address.parse("world://localhost/minecraft/Cave Wars").world).toBe("Cave Wars")
    })

    test("a broken escape is said, not handed to a lab", () => {
        expect(() => address.parse("world://localhost/minecraft/Cave%2")).toThrow(/escaped properly/)
    })
})
