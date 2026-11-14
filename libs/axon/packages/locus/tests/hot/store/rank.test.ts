import { describe, expect, test } from "bun:test"
import { Rng } from "../../../lab/rng"
import { distance, from, type Coord } from "../../../src/pure"
import { testLocus } from "../../locus"

/**
 * The bulk ranker in `store/rank.ts` is the metric implemented a SECOND time —
 * axis-major over columns, because the reference shape cost ~4x in throughput at
 * 50k rows. Duplicating a metric is only acceptable if something binds the two
 * together, and this is that something.
 *
 * If these ever disagree, a ranking and its own explanation have diverged, which
 * is the least debuggable failure the package could have.
 */
describe("bulk ranker equivalence", () => {
    test("agrees with the reference distance EXACTLY on random inputs", async () => {
        const locus = await testLocus()
        const space = locus.space
        const rng = Rng(4242)

        const coords: Coord[] = []
        for (let i = 0; i < 120; i++) {
            coords.push(
                from(space, {
                    threat: rng.next(),
                    fragile: rng.next(),
                    noisy: rng.next(),
                    large: rng.next(),
                    interactive: rng.next(),
                })
            )
            await locus.records.put({ id: `r${i}`, coord: coords[i]! })
        }

        for (let i = 0; i < 12; i++) {
            const probe = from(space, {
                threat: rng.next(),
                fragile: rng.next(),
                noisy: rng.next(),
                large: rng.next(),
                interactive: rng.next(),
            })
            const ranked = await locus.records.near(probe, { limit: 20 })

            for (const hit of ranked.hits) {
                expect(hit.distance!).toBe(distance(space, probe, hit.record.coord))
            }
        }
    })

    test("agrees when scoped to one domain", async () => {
        const locus = await testLocus()
        const space = locus.space
        const rng = Rng(77)

        for (let i = 0; i < 60; i++) {
            await locus.records.put({
                id: `r${i}`,
                coord: from(space, { threat: rng.next(), fragile: rng.next(), noisy: rng.next(), large: rng.next() }),
            })
        }

        // risk is euclidean, form is cosine — both paths exercised.
        for (const domain of ["risk", "form"]) {
            const probe = from(space, { threat: rng.next(), fragile: rng.next(), noisy: rng.next(), large: rng.next() })
            const ranked = await locus.records.near(probe, { domain: domain, limit: 10 })
            for (const hit of ranked.hits) {
                expect(hit.distance!).toBe(distance(space, probe, hit.record.coord, { domain: domain }))
            }
        }
    })

    test("agrees on partially measured rows, where the intersection rule applies", async () => {
        const locus = await testLocus()
        const space = locus.space
        const rng = Rng(9)

        await locus.records.put({ id: "risk-only", coord: from(space, { threat: 0.8, fragile: 0.2 }) })
        await locus.records.put({ id: "form-only", coord: from(space, { noisy: 0.9, large: 0.4 }) })
        await locus.records.put({ id: "both", coord: from(space, { threat: 0.5, fragile: 0.5, noisy: 0.5, large: 0.5 }) })

        const probe = from(space, { threat: 0.7, fragile: 0.3 })
        const ranked = await locus.records.near(probe)

        // form-only shares no measured axis with the probe — dropped, not ranked last.
        expect(ranked.hits.map(hit => hit.record.id)).not.toContain("form-only")
        for (const hit of ranked.hits) {
            expect(hit.distance!).toBe(distance(space, probe, hit.record.coord))
        }
        expect(rng.next()).toBeGreaterThanOrEqual(0)
    })

    test("a probe measuring nothing in scope ranks nobody rather than ranking everybody equally", async () => {
        const locus = await testLocus()
        const space = locus.space
        await locus.records.put({ coord: from(space, { threat: 0.5, fragile: 0.5 }) })

        const ranked = await locus.records.near(from(space, { noisy: 1 }))
        expect(ranked.hits).toEqual([])
    })
})
