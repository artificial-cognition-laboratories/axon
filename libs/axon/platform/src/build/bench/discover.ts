import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import type { BenchConfig, BenchDefinition, BenchMeasurementDefinition, BenchNormalizedConfig, BenchResolvedWorkspaceDefinition } from "@arcforge/types"
import { toAxes } from "./axes"
import { BenchSchema } from "./schema"
import { defineBench } from "@arcforge/types"
import { err } from "@arcforge/err"
import { fsx } from "../../utils/fs"

export type DiscoverOpts = { root: string }

function fail(message: string): never {
    throw err("BENCH_CONFIG_INVALID", { detail: message })
}

/**
 * Duplicate check keyed by something other than `id`.
 *
 * Matrix axes are keyed by their binding point ("model", "config.engine.
 * temperature"), which is deliberately not an identifier — dotted paths are
 * the escape hatch that keeps the named axis set small.
 */
function uniqueBy<T>(items: T[], key: (item: T) => string, kind: string): void {
    const seen = new Set<string>()
    for (const item of items) {
        const value = key(item)
        if (!value) fail(`${kind} key is empty`)
        if (seen.has(value)) fail(`duplicate ${kind} ${JSON.stringify(value)}`)
        seen.add(value)
    }
}

function unique(items: Array<{ id: string }>, kind: string): void {
    const ids = new Set<string>()
    for (const item of items) {
        if (!item.id || !/^[a-zA-Z][a-zA-Z0-9._-]*$/.test(item.id)) fail(`${kind} id ${JSON.stringify(item.id)} is invalid`)
        if (ids.has(item.id)) fail(`duplicate ${kind} id ${JSON.stringify(item.id)}`)
        ids.add(item.id)
    }
}

export function normalizeBenchConfig(config: BenchConfig, opts: { identity: { name: string; version: string; description?: string }; hasWorkspace: boolean; measurements?: BenchMeasurementDefinition[] }): BenchNormalizedConfig {
    // `source` accepts a bare path because that is what an author means
    // nine times out of ten; the object form stays for `{ kind: "empty" }`.
    const declared = config.workspace?.source
    const source = typeof declared === "string"
        ? { kind: "directory" as const, path: declared }
        : declared
            ?? (opts.hasWorkspace ? { kind: "directory" as const, path: "./workspace" } : { kind: "empty" as const })
    const workspace: BenchResolvedWorkspaceDefinition = {
        source,
        retain: config.workspace?.retain ?? "failed",
        capture: {
            changes: config.workspace?.capture?.changes ?? true,
            display: config.workspace?.capture?.display ?? "hidden",
            ignore: config.workspace?.capture?.ignore ?? [".git", "node_modules", ".axon"],
            maxBytes: config.workspace?.capture?.maxBytes ?? 10 * 1024 * 1024,
        },
    }
    const normalized: BenchNormalizedConfig = {
        ...config,
        identity: opts.identity,
        axes: toAxes(config.matrix),
        trials: config.trials ?? 1,
        tests: config.tests ?? ["tests/**/*.bench.ts"],
        measurements: opts.measurements ?? config.measurements ?? [],
        dimensions: config.dimensions ?? [],
        artifacts: config.artifacts ?? [],
        workspace,
    }
    if (!Number.isInteger(normalized.trials) || normalized.trials < 1) fail("trials must be a positive integer")
    if (normalized.tests.length === 0) fail("at least one test pattern is required")
    uniqueBy(normalized.axes, axis => axis.key, "matrix axis")
    unique(normalized.measurements, "measurement")
    unique(normalized.dimensions, "dimension")
    unique(normalized.artifacts, "artifact")
    for (const axis of normalized.axes) {
        if (axis.values.length === 0) fail(`matrix axis ${JSON.stringify(axis.key)} has no values`)
        // uniqueBy, not unique: variation ids are DERIVED from the value
        // ("../agents/a" -> "..-agents-a", 0.7 -> "0.7"), so the identifier
        // rule that governs hand-authored ids does not apply. They only have
        // to be distinct within their axis.
        uniqueBy(axis.values, variation => variation.id, `value on axis ${JSON.stringify(axis.key)}`)
    }
    for (const measurement of normalized.measurements) {
        if (!measurement.label?.trim() || !measurement.description?.trim()) fail(`measurement ${JSON.stringify(measurement.id)} needs label and description`)
        if (measurement.aggregate === "auc" && (measurement.value.kind !== "number" || measurement.grain !== "step")) {
            fail(`measurement ${JSON.stringify(measurement.id)} uses auc but is not a step-grained number`)
        }
        if (measurement.objective && measurement.value.kind !== "number" && typeof measurement.objective === "object") {
            fail(`measurement ${JSON.stringify(measurement.id)} has a numeric objective but is not numeric`)
        }
    }
    return normalized
}

function isDefinition(value: unknown): value is BenchDefinition {
    return !!value && typeof value === "object" && (value as { _kind?: unknown })._kind === "bench" && !!(value as { config?: unknown }).config
}

export function Discover(opts: DiscoverOpts) {
    const root = resolve(opts.root)
    return {
        async load(): Promise<BenchNormalizedConfig> {
            const path = resolve(root, "bench.config.ts")
            if (!fsx.exists(path)) throw err("BENCH_NOT_FOUND", { context: { path: root } })
            const globals = globalThis as typeof globalThis & { defineBench?: typeof defineBench }
            const previous = globals.defineBench
            globals.defineBench = defineBench
            let module: { default?: unknown }
            try {
                module = await import(`${pathToFileURL(path).href}?axon=${Date.now()}`) as { default?: unknown }
            } finally {
                if (previous) globals.defineBench = previous
                else delete globals.defineBench
            }
            if (!isDefinition(module.default)) fail("default export must be defineBench({...})")
            const pkg = await fsx.readJson<{ name?: string; version?: string; description?: string }>(resolve(root, "package.json"))
            if (!pkg) throw err("BENCH_PACKAGE_NOT_FOUND", { context: { root } })
            if (!pkg.name?.trim()) throw err("BENCH_PACKAGE_NAME_REQUIRED")
            if (!pkg.version?.trim()) throw err("BENCH_PACKAGE_VERSION_REQUIRED")
            // Measurements come from the `defineBench<Schema>` type argument,
            // not from the config object — the type is the authoring surface,
            // and this is where it becomes a value the manifest can carry.
            return normalizeBenchConfig(module.default.config, {
                // Identity is package.json's, not the config's — name, version
                // and description are what the registry publishes, and stating
                // them twice is how the two come to disagree.
                identity: { name: pkg.name, version: pkg.version, description: pkg.description },
                hasWorkspace: fsx.exists(resolve(root, "workspace")),
                measurements: await BenchSchema({ root }).load(),
            })
        },

        async list(globPattern = "**/bench.config.ts"): Promise<Array<{ path: string; config: BenchNormalizedConfig }>> {
            const found: Array<{ path: string; config: BenchNormalizedConfig }> = []
            const glob = new Bun.Glob(globPattern)
            for await (const path of glob.scan({ cwd: root, onlyFiles: true, dot: false })) {
                const benchRoot = resolve(root, path, "..")
                found.push({ path: benchRoot, config: await Discover({ root: benchRoot }).load() })
            }
            return found.sort((a, b) => a.path.localeCompare(b.path))
        },
    }
}

export type DiscoverT = ReturnType<typeof Discover>
