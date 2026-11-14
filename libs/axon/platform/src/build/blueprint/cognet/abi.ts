import { err } from "@arcforge/err"
import { KERNEL_ABI_VERSION } from "@arcforge/types"
import { CognetConfigFile } from "./config"

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
 */
export async function cognetAbi(sourceDir: string, specifier: string): Promise<string> {
    const declared = CognetConfigFile({ sourceDir: sourceDir }).read()?.abi
    if (declared === undefined) return KERNEL_ABI_VERSION

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
