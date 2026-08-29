import { join } from "node:path"
import { err } from "@arcforge/err"
import { KERNEL_ABI_VERSION } from "@arcforge/types"
import type { EngineRequirement, EngineRequirements, Modality } from "@arcforge/types"
import { fsx } from "../../../utils/fs"

/**
 * Verify an installed cognet does not target an ABI this kernel cannot provide.
 *
 * A cognet MAY pin `abi` in cognet.config.ts, and the runtime already checks
 * it when the compiled bundle loads (see core/src/cognet/cognet.ts). That
 * check was sufficient while cognets shipped inside the CLI: the two could
 * not disagree. Now that a cognet is an independently versioned registry
 * artifact, an agent can pin `@axon/zero@0.1.0` against a CLI whose kernel has
 * moved on — and the runtime check fires at agent BOOT, from inside a compiled
 * bundle, long after the mistake was made.
 *
 * This is the same check moved to the moment the pairing is chosen: prepare
 * time, naming both versions and the file to edit.
 *
 * An UNPINNED cognet passes trivially and gets this kernel's ABI. That is not
 * a hole: the bundle is compiled from source by this CLI, against this kernel,
 * so it targets this ABI by construction. A pin exists to make a cognet REFUSE
 * a kernel it has not been validated against — an assertion the author opts
 * into, not a field every cognet must restate.
 *
 * Read with a regex rather than by evaluating the config: this runs before
 * anything has compiled the cognet, and evaluating an arbitrary published
 * config to read one field is a far larger operation than reading the field.
 */
export async function cognetAbi(sourceDir: string, specifier: string): Promise<string> {
    const declared = await readCognetAbi(sourceDir)
    if (declared === null) return KERNEL_ABI_VERSION

    if (declared !== KERNEL_ABI_VERSION) {
        throw err("COGNET_ABI_MISMATCH", {
            detail:
                `cognet "${specifier}" pins kernel ABI ${declared}, but this Axon provides ABI ${KERNEL_ABI_VERSION} — `
                + `install a cognet version built for ABI ${KERNEL_ABI_VERSION}, or update Axon`,
            context: { specifier, declaredAbi: declared, kernelAbi: KERNEL_ABI_VERSION },
        })
    }

    return declared
}

/**
 * The ABI a cognet source project PINS, or null when it pins none.
 *
 * Split out from cognetAbi() because three callers need the value for
 * different reasons: prepare compares a pin against this kernel (cognetAbi),
 * the compile step stamps the resolved value into the artifact, and PUBLISH
 * records it on the version row so the registry can answer "newest cognet that
 * fits ABI N" without downloading a tarball.
 *
 * Publishing must not COMPARE against the publishing machine's kernel — a
 * cognet pinning ABI 10 is perfectly publishable from a CLI running ABI 9, and
 * refusing it would make the registry unable to hold anything but the present.
 * It may still fall back to it, because publish compiles from source with this
 * CLI: an unpinned cognet genuinely was validated against this kernel, so
 * stamping that on the row is a fact rather than a guess.
 *
 * Null, never a throw. An absent pin is the ordinary case — see CognetConfig's
 * `abi` — and every caller has a truthful default: this kernel's ABI.
 */
export async function readCognetAbi(sourceDir: string): Promise<string | null> {
    const source = await fsx.readText(join(sourceDir, "cognet.config.ts"))
    if (source === null) return null

    return source.match(/\babi\s*:\s*["'`]([^"'`]+)["'`]/)?.[1] ?? null
}

/**
 * The `models:` a cognet source project declares.
 *
 * Read textually, for the same reason the ABI is: this runs before anything
 * has compiled the cognet, and evaluating an arbitrary published config to
 * read one field is a far larger operation than reading the field. It also
 * runs on a cognet that has not had its dependencies installed yet, where
 * evaluation would fail outright.
 *
 * Deliberately narrow: it matches the `models: { ... }` object literal and
 * pulls `key: "specifier"` pairs out of it. A computed or imported value is
 * not recognised, and that is the honest limit of a textual read — declaring
 * weights is a static fact about a brain, not something a config should be
 * computing.
 */
export async function readCognetModels(sourceDir: string): Promise<Record<string, string>> {
    const source = await fsx.readText(join(sourceDir, "cognet.config.ts"))
    if (source === null) return {}

    const block = source.match(/\bmodels\s*:\s*\{([\s\S]*?)\}/)
    if (!block?.[1]) return {}

    const models: Record<string, string> = {}
    for (const entry of block[1].matchAll(/["'`]?([A-Za-z_$][\w$]*)["'`]?\s*:\s*["'`]([^"'`]+)["'`]/g)) {
        models[entry[1]!] = entry[2]!
    }
    return models
}

/**
 * The `engines:` a cognet source project declares.
 *
 * Read textually, for the same reasons `models:` is: this runs before
 * anything has compiled the cognet and before its dependencies are
 * installed, so evaluating the config is not available even in principle.
 *
 * Unlike `models:`, the value is a map of OBJECTS, so the block cannot be
 * found with a lazy `\{([\s\S]*?)\}` — the first `}` closes the first role,
 * not the map. Braces are matched instead, which is the smallest thing that
 * reads this shape correctly rather than the smallest thing that looks like
 * it does.
 *
 * Declaring inference is a static fact about a brain, exactly like declaring
 * weights: a computed or imported value is not recognised, and that is the
 * honest limit rather than a bug to work around.
 */
export async function readCognetEngines(sourceDir: string): Promise<EngineRequirements> {
    const source = await fsx.readText(join(sourceDir, "cognet.config.ts"))
    if (source === null) return {}

    const body = balanced(source, /\bengines\s*:\s*\{/)
    if (body === null) return {}

    const engines: EngineRequirements = {}
    for (const [role, block] of roles(body)) {
        const requirement = parseRequirement(block)
        if (requirement) engines[role] = requirement
    }
    return engines
}

/** The text inside the first `{...}` following `opener`, with nesting respected. */
function balanced(source: string, opener: RegExp): string | null {
    const start = source.match(opener)
    if (start?.index === undefined) return null

    let depth = 0
    const from = start.index + start[0].length - 1
    for (let i = from; i < source.length; i++) {
        if (source[i] === "{") depth++
        else if (source[i] === "}") {
            depth--
            if (depth === 0) return source.slice(from + 1, i)
        }
    }
    return null
}

/** `name: { ... }` pairs at the top level of an engines block. */
function roles(body: string): Array<[string, string]> {
    const found: Array<[string, string]> = []
    const header = /["'`]?([A-Za-z_$][\w$]*)["'`]?\s*:\s*\{/g

    for (let match = header.exec(body); match; match = header.exec(body)) {
        const block = balanced(body.slice(match.index), /\{/)
        if (block === null) continue
        found.push([match[1]!, block])
        // Skip past this role's body so a nested key is never read as a role.
        header.lastIndex = match.index + match[0].length + block.length
    }
    return found
}

/**
 * One role's declaration.
 *
 * `type`, `in` and `out` are required — a requirement missing any of them
 * cannot be matched against a capability, so it is DROPPED rather than
 * defaulted. Guessing `text -> text` here would bind a role to a model that
 * cannot serve it, which is the one failure this layer exists to move to
 * prepare time.
 */
function parseRequirement(block: string): EngineRequirement | null {
    const type = block.match(/\btype\s*:\s*["'`](generate|transform|stream)["'`]/)?.[1]
    if (!type) return null

    const modality = (field: "in" | "out"): Modality[] => {
        const list = block.match(new RegExp(`\\b${field}\\s*:\\s*\\[([^\\]]*)\\]`))
        if (list?.[1]) {
            return [...list[1].matchAll(/["'`]([a-z]+)["'`]/g)].map(m => m[1] as Modality)
        }
        const single = block.match(new RegExp(`\\b${field}\\s*:\\s*["'\`]([a-z]+)["'\`]`))
        return single?.[1] ? [single[1] as Modality] : []
    }

    const inputs = modality("in")
    const outputs = modality("out")
    if (inputs.length === 0 || outputs.length === 0) return null

    // Numeric separators are ordinary in a config (`100_000`), and a parse
    // that read one as 100 would silently admit a model far too small.
    const context = block.match(/\bcontext\s*:\s*([\d_]+)/)?.[1]
    const flag = (name: string): boolean => new RegExp(`\\b${name}\\s*:\\s*true\\b`).test(block)

    return {
        type: type as EngineRequirement["type"],
        in: inputs,
        out: outputs,
        ...(context ? { context: Number(context.replaceAll("_", "")) } : {}),
        ...(flag("structured") ? { structured: true } : {}),
        ...(flag("parallel") ? { parallel: true } : {}),
        ...(flag("optional") ? { optional: true } : {}),
        ...(flag("primary") ? { primary: true } : {}),
    }
}
