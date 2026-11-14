import { Locus, type LocusHandle } from "../src"
import { testSpace } from "./space"

/**
 * A memory with no disk.
 *
 * Not a mock: the engine under this is the same code sqlite runs, so a hot test
 * here proves the real planner, metric, regions and consolidation.
 */
export async function testLocus(): Promise<LocusHandle> {
    return Locus({ space: testSpace(), conn: { type: "memory" } })
}
