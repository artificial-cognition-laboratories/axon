import { randomBytes, randomUUID } from "node:crypto"
import { err } from "@arcforge/err"
import { alive } from "../processes"
import type { BodyInfo, Embodiment, Lease, LeaseInput } from "../types"
import type { ServedT } from "./served"

export type BodiesOpts = {
    /** The one world these bodies are in. Made with it, and gone with it. */
    world: ServedT
    /** Something a person should know: a body released, a lease swept. */
    notice: (text: string) => void
}

/** A body placed in the running world, as the lab keeps it. */
type Placement = {
    /** Its placement's name in the world — the identity it was leased as, or `<body>-<n>` when a person put it there. */
    name: string
    /** Which of the library's bodies. */
    model: string
    bridge: string
    lease: Lease | null
    startedAt: string
}

/**
 * Bodies — what is placed in ONE running world, and who wears what.
 *
 * One of these per world the lab serves: a lab runs several beside each
 * other, and a body belongs to exactly one of them. The lab fans its own
 * body verbs across them.
 *
 * Unlike a game lab's pool, nothing is kept warm: a body is placed when it is
 * leased, by the name of the body the agent asked for, and taken out when it
 * is released — or when its agent's process is gone. A body a person places
 * is worn by whoever connects first; a leased one only by its lease's token,
 * which the world checks itself.
 */
export function Bodies(opts: BodiesOpts) {
    const placed = new Map<string, Placement>()
    /** Placements a mind is wearing, as the world last said. */
    let worn = new Set<string>()
    let added = 0

    async function place(world: ServedT, input: { body: string; name: string; token?: string }): Promise<string> {
        const answer = await world.ask({ type: "place", body: input.body, name: input.name, ...(input.token ? { token: input.token } : {}) })
        const fields = typeof answer === "object" && answer !== null ? Object.fromEntries(Object.entries(answer)) : {}
        if (typeof fields.bridge !== "string") throw err("WORLD_REFUSED", { detail: `the world placed ${input.name} but said no bridge: ${JSON.stringify(answer)}` })
        return fields.bridge
    }

    function leases(): Lease[] {
        return [...placed.values()].flatMap(placement => (placement.lease ? [placement.lease] : []))
    }

    async function release(id: string, why: string): Promise<void> {
        const lease = leases().find(held => held.id === id)
        if (!lease) throw err("WORLD_LEASE_UNKNOWN", { detail: id })
        placed.delete(lease.body)
        opts.notice(`${lease.body} released from ${lease.agent}: ${why}`)
        if (!opts.world.ended) await opts.world.ask({ type: "remove", name: lease.body })
    }

    function info(placement: Placement): BodyInfo {
        return {
            id: placement.name,
            world: opts.world.name,
            state: worn.has(placement.name) ? "embodied" : "ready",
            model: placement.model,
            bridge: placement.bridge,
            client: null,
            identity: placement.lease?.identity ?? null,
            lease: placement.lease?.id ?? null,
            agent: placement.lease?.agent ?? null,
            error: null,
            // A placed body is the world's process, not one of its own: the world's pid accounts for it.
            pids: [],
            startedAt: placement.startedAt,
        }
    }

    return {
        list(): BodyInfo[] {
            return [...placed.values()].map(info)
        },

        leases: leases,

        /** One of the library's bodies placed for anyone to wear, beside the others. */
        async add(input?: { body?: string }): Promise<BodyInfo> {
            const world = opts.world
            if (!input?.body) throw err("WORLD_BODY_UNKNOWN", { detail: "Atrium places a body by name — say which of the library's bodies (probe, go2, …)" })
            added += 1
            const name = `${input.body}-${added}`
            const bridge = await place(world, { body: input.body, name: name })
            const placement: Placement = { name: name, model: input.body, bridge: bridge, lease: null, startedAt: new Date().toISOString() }
            placed.set(name, placement)
            return info(placement)
        },

        /** The body the agent asked for, placed in the running world as its identity, worn only with the lease's token. */
        async lease(input: LeaseInput): Promise<Embodiment> {
            const world = opts.world
            if (!input.body) throw err("WORLD_BODY_UNKNOWN", { detail: "Atrium's bodies are many: say which to wear — ?body=<body> in the world address, e.g. world://localhost/atrium/kitchen?body=go2" })
            const name = input.identity.replace(/[^A-Za-z0-9_-]/g, "-")
            const held = placed.get(name)
            if (held?.lease) throw err("WORLD_CHARACTER_LEASED", { detail: `${input.identity} is embodied by ${held.lease.agent} in ${world.name}`, context: { identity: input.identity } })
            if (held) throw err("WORLD_CHARACTER_LEASED", { detail: `a body is already placed as ${name} in ${world.name}`, context: { identity: input.identity } })
            const token = randomBytes(24).toString("base64url")
            const bridge = await place(world, { body: input.body, name: name, token: token })
            const lease: Lease = { id: randomUUID(), body: name, world: world.name, agent: input.agent, pid: input.pid, identity: input.identity, stateDir: input.stateDir, at: new Date().toISOString() }
            placed.set(name, { name: name, model: input.body, bridge: bridge, lease: lease, startedAt: lease.at })
            return { lease: lease.id, body: name, world: world.name, identity: input.identity, endpoint: bridge, token: token }
        },

        release(id: string): Promise<void> {
            return release(id, "its agent handed it back")
        },

        /** Leases of agents that are gone, released; who wears what, read again from the world. */
        async sweep(): Promise<void> {
            for (const lease of leases()) {
                if (alive(lease.pid)) continue
                await release(lease.id, `its process ${lease.pid} is gone`)
            }
            if (opts.world.ended) return
            const state = await opts.world.ask({ type: "state" })
            const fields = typeof state === "object" && state !== null ? Object.fromEntries(Object.entries(state)) : {}
            if (!Array.isArray(fields.bodies)) throw err("WORLD_REFUSED", { detail: `the world's state has no bodies: ${JSON.stringify(state)}` })
            worn = new Set(fields.bodies.flatMap(body => (typeof body === "object" && body !== null && "worn" in body && body.worn === true && "name" in body && typeof body.name === "string" ? [body.name] : [])))
        },

        /** The world is gone, and every body with it: each lease ended, saying so. */
        clear(why: string): void {
            for (const placement of placed.values()) {
                if (placement.lease) opts.notice(`${placement.name} released from ${placement.lease.agent}: ${why}`)
            }
            placed.clear()
            worn = new Set()
        },
    }
}

export type BodiesT = ReturnType<typeof Bodies>
