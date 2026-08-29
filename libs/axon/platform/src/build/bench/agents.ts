import { existsSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import { err } from "@arcforge/err"
import type { BenchAxis } from "@arcforge/types"

/**
 * Resolve the agents a matrix names, so every cell has something bootable.
 *
 * An `agent` variation is either a path you wrote or a registry ref you trust:
 *
 *   agent: "./fixtures/subject"     — authored here, committed
 *   agent: "@axon/coding-base"      — resolved from the registry, fetched
 *
 * Registry agents land under `.bench/agents/`, not `fixtures/`. The split is
 * the same one that makes `workspace/` ↔ `fixtures/` clean: `fixtures/` is
 * source you author and commit, `.bench/` is generated and ignored. Vendoring
 * a copy of a shared base into source would put it back under your control —
 * which is precisely what naming a registry version is meant to avoid, since
 * two benchmarks claiming to measure against "a standard coding agent" should
 * be measuring against the same one.
 *
 * The version lands in the directory name because it lands in the manifest: an
 * `agent` pin that says `@axon/coding-base@1.2.0` is a real identity, where a
 * hash of the string "./fixtures/subject" says nothing anyone else can use.
 */

export type ResolvedAgent = {
    /** As written in the matrix. */
    ref: string
    /** Absolute path to a prepared agent project. */
    root: string
    /** Manifest identity: a registry `name@version`, or the ref for a local path. */
    pin: string
}

export type AgentsOpts = {
    root: string
    /** Fetch, extract and prepare a registry artifact. */
    clone(ref: string, cwd: string, options: { dir?: string }): Promise<{ name: string; version: string; root: string }>
    /** Install deps and generate types for a local project. */
    prepare(root: string): Promise<void>
}

/** A scoped registry name, as opposed to a filesystem path. */
export function isRegistryRef(ref: string): boolean {
    return ref.startsWith("@") && !ref.startsWith("./") && !ref.startsWith("../")
}

export function Agents(opts: AgentsOpts) {
    const cacheDir = join(opts.root, ".bench", "agents")

    async function resolveOne(ref: string): Promise<ResolvedAgent> {
        if (!isRegistryRef(ref)) {
            const root = isAbsolute(ref) ? ref : resolve(opts.root, ref)
            if (!existsSync(join(root, "axon.config.ts"))) {
                throw err("BENCH_AGENT_UNRESOLVED", {
                    detail: `${ref} is not an agent project — no axon.config.ts at ${root}`,
                    context: { ref, root },
                })
            }
            // A local agent still needs node_modules and generated types before
            // it can boot, and a bench author should not have to know that.
            await opts.prepare(root)
            return { ref, root, pin: ref }
        }

        const cloned = await opts.clone(ref, cacheDir, { dir: slug(ref) })
        return { ref, root: cloned.root, pin: `${cloned.name}@${cloned.version}` }
    }

    return {
        /**
         * Every agent the matrix names, resolved and prepared.
         *
         * Returns a map keyed by the ref as written, so the runtime can look up
         * what a cell selected without re-deciding local-versus-registry.
         */
        async resolve(axes: BenchAxis[]): Promise<Map<string, ResolvedAgent>> {
            const axis = axes.find(item => item.key === "agent")
            if (!axis) return new Map()

            const resolved = new Map<string, ResolvedAgent>()
            for (const variation of axis.values) {
                const ref = variation.value
                if (typeof ref !== "string") {
                    throw err("BENCH_AGENT_UNRESOLVED", {
                        detail: `agent variations are paths or registry refs, got ${JSON.stringify(ref)}`,
                        context: { value: ref },
                    })
                }
                // Sequential on purpose: two variations of the same registry
                // agent would otherwise race to write the same directory.
                if (!resolved.has(ref)) resolved.set(ref, await resolveOne(ref))
            }
            return resolved
        },
    }
}

/** `@axon/coding-base@1.2.0` → `axon-coding-base@1.2.0`, safe as a directory name. */
function slug(ref: string): string {
    return ref.replace(/^@/, "").replace(/\//g, "-")
}

export type AgentsT = ReturnType<typeof Agents>
