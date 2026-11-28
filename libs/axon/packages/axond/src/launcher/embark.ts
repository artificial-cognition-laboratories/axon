import { address } from "@arcforge/body"
import { err } from "@arcforge/err"
import { LAB_IDS, type LabId, type LabT } from "../labs/types"
import type { LauncherT } from "./launcher"

export type EmbarkOpts = {
    launcher: LauncherT
    /** The labs, by id: a world is made ready in the one its address names. */
    labs: Record<LabId, LabT>
}

/** An agent on its way into a world, as a caller of the daemon is told. */
export type Embarked = {
    /** Its session: what `agents.stop` takes. */
    session: string
    /** The agent's name, as its project declares it. */
    name: string
    /** The world address it was given (`world://localhost/<lab>/<world>`). */
    world: string
}

/**
 * Embark — an agent sent into a world, owned by the daemon: what a surface that is not a
 * terminal asks for (the game's agents list, sprint 127), where `axon <ref> -c` runs one in the
 * person's own. The world is made ready first, so a wrong address fails here, saying why: a
 * game's address (`terra://localhost:<port>`, a world the player opened) is attached to; a lab
 * world is started if it is not up. Then the agent boots with the address, and leases its
 * body itself, as it does under `-c`.
 */
export function Embark(opts: EmbarkOpts) {
    /** The world address `said` comes to, the world up. */
    async function ready(said: string): Promise<string> {
        if (said.trim().toLowerCase().startsWith("terra://")) {
            const world = await opts.labs.terraverse.attach({ address: said.trim() })
            return `world://localhost/terraverse/${encodeURIComponent(world.name)}`
        }
        const connection = address.parse(said)
        const lab = LAB_IDS.find(id => id === connection.lab)
        if (!lab) throw err("WORLD_ADDRESS_INVALID", { detail: `${connection.lab} is not a lab here` })
        if (connection.scenario) throw err("WORLD_REFUSED", { detail: "a scenario is a run: start it with labs.<lab>.runs.start" })
        if (connection.world) await opts.labs[lab].start({ name: connection.world })
        return address.format(connection)
    }

    return {
        /** `agent` (a path, a profile name, `@scope/name`) put in the world at `world`. */
        async run(input: { agent: string; world: string }): Promise<Embarked> {
            const world = await ready(input.world)
            const launched = await opts.launcher.launch(input.agent, { connect: world })
            return { session: launched.session, name: launched.name, world: world }
        },
    }
}

export type EmbarkT = ReturnType<typeof Embark>
