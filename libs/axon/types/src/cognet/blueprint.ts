import type { AxonEntryEvent } from "../session/events/entries"
import type { CognetDefinition } from "./cognet"

/**
 * The cognet slot in the agent blueprint — how a brain reaches the runtime.
 *
 * Two carriers, one contract:
 * - `path` + `hash` — the CLI form. `axon prepare` bundles the cognet
 *   project into `<agent>/.agent/cognet/cognet.mjs` (single self-contained
 *   ESM file, default export = defineCognet(...)); the blueprint stays pure
 *   data. The runtime imports `path?v=hash` (cache-busted per content) and
 *   verifies the hash BEFORE evaluating — a tampered brain never half-loads.
 * - `definition` — the live-object form, for tests and embedded use. Same
 *   contract, no disk.
 *
 * Identity (name/version/abi/wakeOn) rides alongside for display, wake
 * policy, and pre-load checks; the loaded definition is the authority and
 * a disagreement fails loudly.
 */
export type CognetBlueprint = {
    name: string
    version: string
    /** Kernel ABI contract the artifact targets — checked again at load from the definition itself. */
    abi: string
    /** Declarative wake mask — overrides the definition's own default. */
    wakeOn?: Array<keyof AxonEntryEvent>

    /**
     * Resolved model weights — the cognet's local name → an absolute path on
     * THIS machine, already fetched and verified.
     *
     * Carried on the blueprint rather than resolved by the kernel because
     * acquisition is a build-time concern (it downloads, it verifies, it can
     * fail loudly at prepare); the runtime only hands the paths over. That
     * also keeps the seam where a deployment image bakes weights in at build
     * time and the runtime cannot tell the difference.
     */
    models?: Readonly<Record<string, string>>
} & (
    | {
        /** Absolute path to the compiled bundle — <agent>/.agent/cognet/cognet.mjs. */
        path: string
        /** sha256 (hex) of the bundle contents — integrity + reload detection + import cache-bust. */
        hash: string
    }
    | {
        /** Live definition — test/embedded path. The CLI always emits path+hash. */
        definition: CognetDefinition
    }
)
