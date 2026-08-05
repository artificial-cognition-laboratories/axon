import { errorMap } from "../src/map"

/**
 * The map's contract, enforced.
 *
 * A code is a stable identity a user or a support thread can reference —
 * which only holds if exactly one failure answers to it. Six codes were
 * duplicated across distinct entries before this test existed
 * (AX-PROJECT-004/005/006/009/011/012 each named two unrelated failures), so
 * a reader given "AX-PROJECT-011" could not tell a wrong project kind from a
 * missing tar binary. The map is hand-numbered and 150+ entries long; nothing
 * but this test stops the next collision.
 */
describe("error map", () => {
    it("gives every entry a unique code", () => {
        const seen = new Map<string, string>()
        const collisions: string[] = []

        for (const [name, entry] of Object.entries(errorMap)) {
            const previous = seen.get(entry.code)
            if (previous) collisions.push(`${entry.code}: ${previous} and ${name}`)
            else seen.set(entry.code, name)
        }

        expect(collisions).toEqual([])
    })

    it("gives every entry the AX-<DOMAIN>-<NNN> shape", () => {
        const malformed = Object.entries(errorMap)
            .filter(([, entry]) => !/^AX-[A-Z]+-\d{3}$/.test(entry.code))
            .map(([name, entry]) => `${name}: ${entry.code}`)

        expect(malformed).toEqual([])
    })

    it("gives every entry a title and a description", () => {
        const incomplete = Object.entries(errorMap)
            .filter(([, entry]) => !entry.title?.trim() || !entry.description?.trim())
            .map(([name]) => name)

        expect(incomplete).toEqual([])
    })
})
