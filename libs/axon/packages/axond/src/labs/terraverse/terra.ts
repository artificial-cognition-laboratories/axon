import { existsSync } from "node:fs"
import { err } from "@arcforge/err"
import type { BridgeState } from "../types"

export type TerraOpts = {
    /** Which build of axond this is: it says which terra it goes with (COMMANDS). */
    build: "production" | "development"
    /** The `terra` to run. Default: AXON_TERRA, else the build's, on PATH. */
    path?: string
}

/**
 * Which terra each build of axond runs, as each build of Axon is its own command: the installed
 * daemon the installed `terra` (the Terraverse launcher puts it on PATH), the one run from source
 * (`axonl`) `terral`, Terraverse from its checkout.
 */
const COMMANDS = { production: "terra", development: "terral" } as const

/**
 * Terra — the `terra` every world of this lab runs (`terra serve --world-contract`). It comes
 * with the game, from the Terraverse launcher: the lab never builds or stages it, only finds
 * it, and says so when it can't. The lab contract's "bridge" is terra itself.
 */
export function Terra(opts: TerraOpts) {
    const named = opts.path ?? process.env.AXON_TERRA ?? null

    /** The executable, or null when there's none. */
    function found(): string | null {
        if (named) return existsSync(named) ? named : Bun.which(named)
        return Bun.which(COMMANDS[opts.build])
    }

    function problem(): string | null {
        if (found()) return null
        if (named) return `no terra at ${named} (AXON_TERRA)`
        return opts.build === "production"
            ? "terra isn't on PATH — install Terraverse (terraverse.arclabs.it) and play once from its launcher"
            : "terral isn't on PATH — link a Terraverse checkout's apps/cli/bin/terral into ~/.local/bin (or set AXON_TERRA)"
    }

    async function state(): Promise<BridgeState> {
        return { name: "terra", source: found(), built: null, staged: null, stale: false }
    }

    return {
        /** The executable a world runs. Throws, saying why, when there's none. */
        path(): string {
            const path = found()
            if (!path) throw err("WORLD_MOD_MISSING", { detail: problem() ?? "no terra" })
            return path
        },
        problem: problem,
        state: state,
        /** terra ships with the game: there's nothing here to build. */
        async build(): Promise<BridgeState> {
            throw err("WORLD_MOD_BUILD_FAILED", { detail: "terra comes with Terraverse, from its launcher — there's nothing to build here" })
        },
    }
}

export type TerraT = ReturnType<typeof Terra>
