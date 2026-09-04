import type { AirMode, AirProtocolName } from "./types"
import { MODE_DEFAULTS, resolveProtocol } from "./protocol"

/**
 * Grammar — the single owner of the AIR format contract.
 *
 * Everything that defines what the model may emit lives here: the enabled
 * modes, the meta prose, the contract rules, and the tag set the parser
 * accepts. Render and Parse both consume this handle, so the promise made
 * to the model and the grammar accepted back can never drift.
 *
 * The variability point is `protocol` — a named grammar resolved as a unit
 * (see protocol/). Modes are not chosen independently of the prose that
 * describes them, so a caller picks a protocol and gets all three parts
 * consistent, or overrides modes explicitly and takes responsibility for
 * the pairing.
 */

export type AirOpts = {
    /** The output grammar. Default: classic (the two-block <typescript>/<text> contract). */
    protocol?: AirProtocolName
    /** Override the protocol's mode list. Rarely needed — prefer choosing a protocol. */
    modes?: AirMode[]
    /** Extra contract rules appended after the protocol's rules. */
    extraRules?: string[]
}

export function Grammar(opts: AirOpts = {}) {
    const protocol = resolveProtocol(opts.protocol ?? "classic")
    const modes = opts.modes ?? protocol.modes

    return {
        protocol: protocol.name,
        modes,
        meta: protocol.meta,
        rules: [...protocol.rules, ...(opts.extraRules ?? [])],
        examples: protocol.examples,

        /** Default description for a mode, unless the mode overrides it. */
        describe(mode: AirMode): string {
            return mode.description ?? MODE_DEFAULTS[mode.type]
        },

        /**
         * Block tags the parser accepts.
         *
         * Thinking is always parseable but is never a contract mode: models
         * do not choose to emit it, providers inline it. The parser must
         * recognise the tag in order to strip it, which is a parse concern,
         * not a promise made to the model.
         */
        tags(): string[] {
            return [...new Set(["thinking", ...modes.map(m => m.type)])]
        },
    }
}

export type GrammarT = ReturnType<typeof Grammar>
