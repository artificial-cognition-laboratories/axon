import type { AxonBlueprint, EngineCloud } from "@arcforge/types"
import { Inject } from "../platform"
import { Grants } from "./grants"
import { Inference } from "./inference"
import { Conformance, type Outcome } from "./services/conformance"

/** One use, checked: what filled it, and how each of its interface's cases went — null when it ships none, or nothing filled it. */
export type Conformed = { use: string; interface: string; provider: string | null; cases: Outcome[] | null }

/**
 * Conform — every use an agent's cognet declares, filled as a boot would fill
 * it, and held to its interface's conformance cases.
 *
 * Resolution and grants are the boot's own, so what is checked is what would
 * run: the same route, the same provider the agent wrote, the same limits.
 * Nothing is loaded into a kernel and no mind wakes.
 */
export function Conform(opts: { blueprint: AxonBlueprint; cloud: EngineCloud }) {
    return {
        async run(): Promise<Conformed[]> {
            // A provider the agent wrote calls defineProvider at import, as it does at boot.
            Inject().macros()
            const engines = await Inference({ blueprint: opts.blueprint, cloud: opts.cloud })
            const grants = await Grants({ blueprint: opts.blueprint, ...(engines ? { engines: engines } : {}) })
            const conformed: Conformed[] = []
            for (const [name, use] of Object.entries(opts.blueprint.cognet.uses ?? {})) {
                const provider = grants.granted(name)
                const cases = provider && use.conformance ? await Conformance({ use: use, provider: provider, dir: use.conformance }).run() : null
                conformed.push({ use: name, interface: use.named, provider: provider?.name ?? null, cases: cases })
            }
            return conformed
        },
    }
}
