export type BenchProtocolVersions = {
    events: string
    manifest: string
    observations: string
    artifacts: string
}

export type BenchHarnessIdentity = {
    name: string
    version: string
    runtime: string
    bun: string
}

export const BENCH_PROTOCOL = {
    events: "1.0.0",
    manifest: "1.0.0",
    observations: "1.0.0",
    artifacts: "1.0.0",
} as const satisfies BenchProtocolVersions

