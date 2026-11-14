/**
 * The pure door — the basis and the algebra, with no IO and no SQLite.
 *
 * Producers, Terry's L1, and every test of the maths import from here. The
 * guarantee in the name is the point: anything reachable through `@arcforge/locus/pure`
 * can be exercised with two arrays and nothing open, which is the same rule that
 * keeps a cognet's mechanisms testable without a world.
 */
export * from "./space"
export * from "./coord"
