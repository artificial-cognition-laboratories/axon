import { createHash } from "node:crypto"
import { mkdir, readdir, rm, stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { err } from "@arcforge/err"
import type { AxonBlueprint, AxonEventMap, AxonSpanName, CognetBlueprint, CognetDefinition, CognetWake, KernelAbi } from "@arcforge/types"
import { KERNEL_ABI_VERSION } from "@arcforge/types"

type CognetOpts = {
    blueprint: AxonBlueprint
    /**
     * Where to report resolution cost. Optional: a reload resolves the same
     * way with nobody watching, and tests construct a cognet with no session
     * at all.
     */
    session?: {
        span<K extends AxonSpanName, T>(
            name: K,
            start: AxonEventMap[`${K}:start`],
            run: () => Promise<T>,
            complete?: (value: T) => Omit<AxonEventMap[`${K}:complete`], "durationMs">,
        ): Promise<T>
    }
}

/**
 * Cognet — the runtime's handle over one cognition artifact.
 *
 * Orchestrator only: resolves the definition the blueprint carries (bundle
 * on disk from the CLI, or a live object from tests) and manages it
 * (manager pattern — `current` is swappable on reload, nobody downstream
 * knows). The loop lives in the DEFINITION, built as its own project
 * (cognets/*) and bundled by `axon prepare` into <agent>/.agent/cognet/ —
 * this layer never implements cognition, and there is no other way to
 * load a brain.
 *
 * Async factory deliberately: construction resolves the definition (a disk
 * read + import for the CLI form), so the handle can never be observed
 * half-built.
 *
 * Lifecycle contract with the kernel:
 *   Cognet({ blueprint })  → resolve + configure (definition sees its blueprint)
 *   kernel exec            → load(abi): ABI checked, definition.load(abi) runs
 *   wakes                  → forwarded to the definition
 *   update(blueprint)      → changed artifact (hash/ref) swaps the brain;
 *                            same artifact re-fans config only
 */
export async function Cognet(opts: CognetOpts) {
    let blueprint = opts.blueprint
    const slot = blueprint.cognet
    let resolved = opts.session
        ? await opts.session.span(
            "axon:cognet",
            { specifier: "path" in slot ? slot.path : null } as never,
            () => resolve(slot),
            (value: ResolvedCognet) => ({
                // `cognet`, not `name`: `data.name` is span-identity by
                // convention (the ontology guard pairs brackets on it), and a
                // payload field that only appears on the closing half would
                // split this span into an orphaned open and close.
                cognet: value.definition.name,
                version: value.definition.version,
                bytes: value.bytes ?? 0,
                hashMs: value.hashMs ?? 0,
                importMs: value.importMs ?? 0,
            }) as never,
        )
        : await resolve(slot)
    let current = resolved.definition
    let disposeArtifact = resolved.dispose
    let abi: KernelAbi | null = null

    // configuration precedes exec — the definition sees its blueprint
    // before load() and before every wake that follows a reload
    current.update?.(blueprint)

    /** exec(): ABI compatibility is checked HERE — a mismatched artifact never half-loads. */
    async function exec(definition: CognetDefinition, kernel: KernelAbi) {
        if (definition.abi !== KERNEL_ABI_VERSION) {
            throw err("COGNET_ABI_MISMATCH", {
                detail: `${definition.name}@${definition.version} targets ABI ${definition.abi}, kernel provides ${KERNEL_ABI_VERSION}`,
                context: { name: definition.name, version: definition.version, targetAbi: definition.abi, kernelAbi: KERNEL_ABI_VERSION },
            })
        }
        await definition.load(kernel)
    }

    async function load(kernel: KernelAbi) {
        try {
            await exec(current, kernel)
            abi = kernel
        } catch (cause) {
            await disposeArtifact?.()
            throw cause
        }
    }

    return {
        get name() { return current.name },
        get version() { return current.version },
        get abi() { return current.abi },
        /** How the scheduler should invoke this cognet — read live, so a reload that changes mode takes effect on the next attach. */
        get mode() { return current.mode },

        /** Which entry types wake this brain; absent = everything. Read live, same reason as mode. */
        get wakeOn() { return current.wakeOn },

        load: load,

        wake(wake: CognetWake) {
            return current.wake(wake)
        },

        /**
         * The agent changed. A reload that carries a NEW artifact (different
         * bundle hash, or a different live definition) swaps the brain: new
         * definition resolved, configured, and exec'd before the old one
         * unloads — overlap, not gap. Same artifact = config re-fan only.
         */
        async update(next: AxonBlueprint) {
            const changed = artifactChanged(blueprint.cognet, next.cognet)
            blueprint = next

            if (changed) {
                const previous = current
                const previousDispose = disposeArtifact
                const candidateResolved = await resolve(next.cognet)
                const candidate = candidateResolved.definition
                candidate.update?.(next)
                // Transactional swap: a candidate that cannot exec never
                // becomes current and never strands the known-good brain.
                try {
                    if (abi) await exec(candidate, abi)
                } catch (cause) {
                    await candidateResolved.dispose?.()
                    throw cause
                }
                current = candidate
                disposeArtifact = candidateResolved.dispose
                await previous.unload?.()
                await previousDispose?.()
                return
            }

            current.update?.(next)
        },

        async unload() {
            try {
                await current.unload?.()
            } finally {
                await disposeArtifact?.()
            }
        },
    }
}

export type CognetT = Awaited<ReturnType<typeof Cognet>>

// ── Resolution ────────────────────────────────────────────────────────────────

function artifactChanged(before: CognetBlueprint, after: CognetBlueprint): boolean {
    if ("definition" in before || "definition" in after) {
        const a = "definition" in before ? before.definition : null
        const b = "definition" in after ? after.definition : null
        return a !== b
    }
    return before.hash !== after.hash
}

/**
 * Blueprint slot → live definition.
 *
 * CLI form: verify the bundle's sha256 against the blueprint BEFORE
 * evaluating a single line of it, then import with the hash as a
 * cache-buster (the ES module registry keys on URL — a rebuilt bundle at
 * the same path must produce a FRESH module instance, whose module scope
 * becomes the new brain's resident RAM). The stale module of a swapped-out
 * brain cannot be evicted from the registry — one leaked scope per brain
 * reload, the standard HMR trade.
 */
type ResolvedCognet = {
    definition: CognetDefinition
    /** Removes the per-runtime module copy once its owning kernel has stopped. */
    dispose?: () => Promise<void>
    /** Bundle size on disk. Absent for the live-definition form, which reads nothing. */
    bytes?: number
    /**
     * Split because they grow for different reasons: hashing scales with
     * bundle size, the import is JS compile time. A boot that got slower has
     * to be able to say which.
     */
    hashMs?: number
    importMs?: number
}

async function resolve(slot: CognetBlueprint): Promise<ResolvedCognet> {
    if ("definition" in slot) return { definition: validate(slot, slot.definition) }

    const file = Bun.file(slot.path)
    if (!(await file.exists())) {
        throw err("COGNET_MISSING", { detail: `no bundle at ${slot.path} — run \`axon prepare\``, context: { path: slot.path } })
    }

    const hashBegan = Date.now()
    const contents = await file.bytes()
    const hash = createHash("sha256").update(contents).digest("hex")
    const hashMs = Date.now() - hashBegan
    if (hash !== slot.hash) {
        throw err("COGNET_HASH_MISMATCH", {
            detail: `${slot.path} does not match the blueprint (expected ${slot.hash.slice(0, 12)}…, found ${hash.slice(0, 12)}…) — stale or tampered bundle; run \`axon prepare\``,
            context: { path: slot.path, expected: slot.hash, found: hash },
        })
    }

    // Module scope is a brain's resident RAM, and one brain belongs to one
    // kernel. Bun may reuse a file module even when only its query string
    // differs, so query-based cache busting is not a reliable isolation
    // boundary. Give every runtime a distinct physical entry instead.
    //
    // The copies live under .agent (already ignored by the project watcher)
    // and are removed with the owning runtime. The compiled cognet is a
    // self-contained ESM artifact, so no relative import graph needs copying.
    const instanceDir = join(dirname(slot.path), ".instances")
    const instancePath = join(instanceDir, `${slot.hash}.${crypto.randomUUID()}.mjs`)
    await mkdir(instanceDir, { recursive: true })
    await sweepStaleInstances(instanceDir)
    await Bun.write(instancePath, contents)

    try {
        const importBegan = Date.now()
        const module = (await import(pathToFileURL(instancePath).href)) as { default?: unknown }
        const importMs = Date.now() - importBegan
        return {
            definition: validate(slot, module.default),
            dispose: async () => { await rm(instancePath, { force: true }) },
            bytes: contents.byteLength,
            hashMs: hashMs,
            importMs: importMs,
        }
    } catch (cause) {
        await rm(instancePath, { force: true })
        throw cause
    }
}

/**
 * How long an instance copy must be untouched before a later boot may delete
 * it. Comfortably longer than the window between `mkdir` and the `import` that
 * pins the file, so a runtime booting concurrently can never have its own copy
 * swept out from under it.
 */
const STALE_INSTANCE_MS = 60 * 60_000

/**
 * Remove instance copies orphaned by runtimes that never disposed.
 *
 * `dispose()` deletes the copy on clean shutdown, but a `kill -9` — or a crash,
 * or a debugger stop — skips it, and nothing else ever did. Every such exit
 * leaked a full copy of the compiled cognet: 21 files / 1.8MB in one local
 * agent, growing without bound, and published into the release tarball.
 *
 * Age is the only safe signal, because a sibling runtime's copy is a live
 * import that must not be touched. Sweeping on boot (rather than on dispose)
 * is what makes it work at all — the process that leaked the file is by
 * definition not around to clean it up.
 *
 * Best-effort: a failure here must never stop a brain from loading.
 */
async function sweepStaleInstances(instanceDir: string): Promise<void> {
    try {
        const cutoff = Date.now() - STALE_INSTANCE_MS
        const entries = await readdir(instanceDir)
        await Promise.all(entries.map(async entry => {
            const path = join(instanceDir, entry)
            try {
                const info = await stat(path)
                if (info.mtimeMs < cutoff) await rm(path, { force: true })
            } catch {
                // Raced with another runtime's dispose — already gone, fine.
            }
        }))
    } catch {
        // No directory yet, or an unreadable one. Not a reason to fail a boot.
    }
}

/** The bundle's default export must be a definition, and must be who the blueprint says it is. */
function validate(slot: CognetBlueprint, candidate: unknown): CognetDefinition {
    if (
        typeof candidate !== "object" || candidate === null ||
        typeof (candidate as CognetDefinition).load !== "function" ||
        typeof (candidate as CognetDefinition).wake !== "function" ||
        typeof (candidate as CognetDefinition).name !== "string" ||
        typeof (candidate as CognetDefinition).abi !== "string"
    ) {
        throw err("COGNET_INVALID", { detail: `${slot.name} did not yield a cognet definition (default export must be defineCognet(...))`, context: { name: slot.name } })
    }

    const definition = candidate as CognetDefinition
    if (definition.name !== slot.name) {
        throw err("COGNET_IDENTITY_MISMATCH", {
            detail: `blueprint says "${slot.name}", artifact says "${definition.name}"`,
            context: { expected: slot.name, found: definition.name },
        })
    }

    return definition
}
