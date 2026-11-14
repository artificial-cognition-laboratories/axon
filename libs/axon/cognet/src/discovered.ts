import { err } from "@arcforge/err"
import { definitions } from "./ecs"
import { systems as registry, type NamedSystem } from "./schedule"
import { AsyncNative, Native, type AsyncNativeModule, type NativeModule } from "./native"

/** One file the compile step found defining components, queries or frames. */
export type DiscoveredDefinitions = {
    /** Path under the cognet root, forward slashes: `L0/vision/components.ts`. */
    file: string
    module: Record<string, unknown>
    /** The exports written as `export const <name> = component(...)`, `query(...)` or `frame(...)`. */
    names: readonly string[]
}

/** One `*.system.ts` file the compile step found. */
export type DiscoveredSystem = {
    /** Path under the cognet root, forward slashes: `L0/vision/motion/flow.system.ts`. */
    file: string
    module: Record<string, unknown>
}

export type DiscoveredOpts = {
    definitions: readonly DiscoveredDefinitions[]
    systems: readonly DiscoveredSystem[]
    /** The cognet's compiled `*.system.rs`, when it has any: one module holding them all. See `Native`. */
    native?: NativeModule
    /** Python systems use the same declarations and value contract through a process. */
    python?: AsyncNativeModule
}

/**
 * Discovered — what the compile step found, bound into a runnable shape.
 *
 * Called once by the generated entry, after every discovered module has been
 * imported. It NAMES each component, query and frame from where it is defined
 * (`L0/vision/components.ts` exporting `flow` → `L0/vision/flow`, scoped to
 * `L0/vision`), and names each system from its path (`L0/vision/motion/flow`).
 *
 * The generated entry imports this by name, and only a host that can run
 * systems exports it — so a new CLI compiling against an old installed host
 * fails at build time instead of producing a brain whose systems silently
 * never run.
 */
export function Discovered(opts: DiscoveredOpts): { systems: NamedSystem[] } {
    const taken = new Map<string, string>()

    for (const found of opts.definitions) {
        const scope = folder(found.file)
        for (const name of found.names) {
            const handle = found.module[name]
            if (!definitions.is(handle)) {
                throw err("COGNET_DISCOVERY_INVALID", {
                    detail: `${found.file} exports "${name}" as a component, query or frame, but its value is not one`,
                })
            }
            const full = scope ? `${scope}/${name}` : name
            const owner = taken.get(full)
            if (owner && owner !== found.file) {
                throw err("COGNET_DISCOVERY_INVALID", {
                    detail: `"${full}" is defined in both ${owner} and ${found.file} — two definitions in one folder need different names`,
                })
            }
            taken.set(full, found.file)
            definitions.name(handle, { name: full, scope: scope })
        }
    }

    const named = opts.systems.map(found => {
        const system = found.module.default
        if (!registry.is(system)) {
            throw err("COGNET_DISCOVERY_INVALID", {
                detail: `${found.file} must \`export default defineSystem({ ... })\``,
            })
        }
        return { name: found.file.replace(/\.system\.ts$/, ""), system: registry.resolve(system) }
    })

    // Native systems last: their declarations name handles by their full names, which exist only now.
    const native = opts.native ? Native({ module: opts.native }).systems() : []
    const python = opts.python ? AsyncNative({ module: opts.python }).systems() : []
    for (const one of native) if (named.some(other => other.name === one.name)) {
        throw err("COGNET_DISCOVERY_INVALID", { detail: `${one.name} is both a .system.ts and a .system.rs — one system name has one implementation` })
    }
    for (const one of python) if (named.some(other => other.name === one.name)) {
        throw err("COGNET_DISCOVERY_INVALID", { detail: `${one.name} is both a .system.ts and a .system.py — one system name has one implementation` })
    }
    for (const one of python) if (native.some(other => other.name === one.name)) {
        throw err("COGNET_DISCOVERY_INVALID", { detail: `${one.name} has both a Rust and a Python system — one system name has one implementation` })
    }

    return { systems: [...named, ...native, ...python] }
}

/** The folder a file sits in, relative to the cognet root. `""` at the root. */
function folder(file: string): string {
    const index = file.lastIndexOf("/")
    return index === -1 ? "" : file.slice(0, index)
}
