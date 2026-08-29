import { join } from "node:path"
import type { AxonScript } from "@arcforge/types"
import { err } from "@arcforge/err"
import { fsx } from "../../../utils/fs"
import type { Scanned } from "../types"

/**
 * `typescript` is ~175ms of module evaluation, and importing it here made
 * every consumer of the blueprint pay that at IMPORT time — before knowing
 * whether the agent has a single script to analyse. Together with the Vue
 * toolchain behind vstr it was the whole of a ~460ms import cost that ran
 * ahead of any actual work.
 *
 * Loaded on first use and memoised: an agent with scripts pays it once, an
 * agent without never loads the compiler at all. `tsast` rides the same gate
 * because it is a thin wrapper over the same module.
 */
type TsModule = typeof import("typescript")
type TsastModule = typeof import("../../../utils/tsast")

let toolchain: Promise<{ ts: TsModule; tsast: TsastModule["tsast"] }> | null = null
function loadToolchain() {
    toolchain ??= Promise.all([import("typescript"), import("../../../utils/tsast")])
        .then(([tsMod, tsastMod]) => ({ ts: tsMod.default, tsast: tsastMod.tsast }))
    return toolchain
}

/**
 * Scripts — src/scripts/*.ts. Args come from the defineArgs<{...}>() type
 * argument; description from the file-leading JSDoc. Static analysis only.
 */
/**
 * Whether a file the author wrote that cannot be READ is fatal.
 *
 * True for an agent's own source: the agent is defined by what its author
 * wrote, so silently running a subset of it produces an agent nobody asked
 * for. Invalid state, and invalid states crash.
 *
 * False for a MODULE's, and that is the whole distinction: an agent that
 * installed a broken module is not an invalid agent — it is the agent it was
 * before the install. Crashing the runtime over one dependency leaves the user
 * unable to boot the terminal they need in order to remove it.
 *
 * Degrading was previously rejected because a warning "reached nobody at
 * runtime" — true then, since build:warning classified as debug and was hidden
 * at default verbosity. It is now info-level and renders as its own card, and
 * a module's failure additionally reaches the MODEL through scope.unavailable.
 *
 * Defaults to true: a caller that has not thought about it gets the strict
 * behaviour, and only the module scanner opts out.
 */
export async function Scripts(root: string, opts: { prefix?: string; required?: boolean } = {}): Promise<Scanned<AxonScript>> {
    const scriptsDir = join(root, "src", "scripts")
    const entries: AxonScript[] = []
    const warnings: Scanned<AxonScript>["warnings"] = []

    for (const file of await fsx.list(scriptsDir)) {
        if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue
        const filePath = join(scriptsDir, file)
        const name = file.slice(0, -3)
        const prefixed = opts?.prefix ? `${opts.prefix}:${name}` : name

        try {
            const source = (await fsx.readText(filePath)) ?? ""
            const { ts, tsast } = await loadToolchain()
            const args = extractDefineArgs(ts, tsast, filePath, source)
            const description = tsast.leadingDescription(source)
            entries.push({
                name: prefixed,
                filePath,
                ...(description !== undefined ? { description } : {}),
                ...(args.length > 0 ? { args } : {}),
            })
        } catch (error) {
            // A script that cannot be processed means `axon run <name>` reports
            // it as not found while its file sits in src/scripts/. Fatal for
            // the agent's own scripts, and a reported gap for a module's.
            const failure = err("SCRIPT_LOAD_FAILED", {
                detail: `${filePath} — ${error instanceof Error ? error.message : String(error)}`,
                context: { file: filePath },
                cause: error,
            })
            // Strict for an agent's own files, degraded for a module's.
            // Per FILE: one unreadable script skips that script, never the
            // rest of the directory beside it.
            if (opts.required !== false) throw failure
            warnings.push({ domain: "scripts", error: failure.message, cause: failure })
            continue
        }
    }

    return { entries, warnings }
}

function extractDefineArgs(
    ts: TsModule,
    tsast: TsastModule["tsast"],
    filePath: string,
    source: string,
): Array<{ name: string; type: string; required?: boolean }> {
    const src = tsast.parse(filePath, source)
    const args: Array<{ name: string; type: string; required?: boolean }> = []

    tsast.visitCalls(src, "defineArgs", call => {
        const typeArg = call.typeArguments?.[0]
        if (!typeArg || !ts.isTypeLiteralNode(typeArg)) return
        for (const member of typeArg.members) {
            if (ts.isPropertySignature(member) && ts.isIdentifier(member.name)) {
                args.push({
                    name: member.name.text,
                    type: member.type ? member.type.getText(src) : "unknown",
                    required: !member.questionToken,
                })
            }
        }
    })

    return args
}
