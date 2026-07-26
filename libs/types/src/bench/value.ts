/** JSON is the portable boundary for definitions, manifests, and observations. */
export type BenchScalar = string | number | boolean
export type BenchValue = null | BenchScalar | BenchValue[] | { [key: string]: BenchValue }

/** Content and schema identities use lowercase, algorithm-qualified hashes. */
export type BenchHash = `${string}:${string}`

