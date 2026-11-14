import { randomUUID } from "node:crypto"
import { err } from "@arcforge/err"
import { alive } from "../processes"
import type { BodyHandle, EndpointT } from "../body/index"
import type { BodyInfo, Embodiment, Lease, LeaseInput, Notice, RunningWorld } from "../types"

export type PoolOpts = {
    /**
     * Build one body for this slot. The pool never constructs a client itself —
     * that is the whole of what differs between engines, and handing it in is
     * what makes everything below engine-neutral.
     */
    body(input: { id: string; slot: number }): BodyHandle
    /** The world bodies join. Null when none is running — leasing then fails loudly. */
    world(): RunningWorld | null
    /**
     * That world, served — what an agent's address does when it names one.
     *
     * This lab runs one world at a time, so `start` gives back the one
     * already up when it is the one asked for and refuses when it is not;
     * either way the agent is told, rather than finding itself somewhere
     * else.
     */
    start(input: { name: string }): Promise<RunningWorld>

    /**
     * How many bodies this ENGINE can afford, and how eagerly to keep them warm.
     *
     * Per engine, not per pool, because a body's cost is the engine's: a
     * Terraria client is ~1–1.5GB and cheap to boot, a Minecraft client wants
     * 2GB of heap and saturates several cores while it class-loads and meshes
     * chunks. Sharing one set of numbers is what this leaf did when it was
     * extracted from Terraria, and Minecraft inherited limits nobody had sized
     * for it.
     */
    limits?: {
        /** Bodies kept ready beyond those leased, so the next agent never waits for a boot. */
        spares?: number
        /** What one machine commits to this lab. */
        max?: number
        /**
         * How long a newly embodied body is left alone before another may boot.
         *
         * Booting a client is the most expensive thing this pool does, and the
         * first minute in a world is the most expensive thing a body does —
         * connecting, then streaming chunks. Overlapping them starved the
         * in-world client's tick thread past the server's 30s keepalive window,
         * and it was dropped with "lost connection: Timed out" while every
         * process still looked healthy. Measured at exactly 45s, twice.
         */
        settleMs?: number
    }
    /** How often dead agents and failed bodies are noticed, ms. */
    sweepMs?: number
    /** Where a leased body speaks the body contract: opened once the body is in the world, closed when it is released. */
    endpoint(body: BodyHandle): EndpointT
}

/** What an engine gets when it states no limits of its own — Terraria's, which these were written for. */
const DEFAULTS = { spares: 1, max: 4, settleMs: 0 } as const
/** How often dead agents and dead bodies are noticed. */
const SWEEP_MS = 3_000
/** How long a lease waits for a body that is still booting. */
const WAIT_MS = 180_000
/**
 * Consecutive boot failures before the pool stops replacing bodies. A body
 * that fails to boot fails for a reason the next one will share — without a
 * limit, the sweep's "replace what failed" becomes a spawn loop.
 */
const MAX_BOOT_FAILURES = 3
/** Problems kept for the world's overview — enough to see a pattern, bounded so a loop cannot grow it. */
const NOTICES_KEPT = 20

/**
 * Pool — the warm clients an engine's lab keeps, and who is in which.
 *
 * A lease is an agent's claim on a body for as long as the agent's process
 * lives: the sweep releases it when the pid dies, so a crashed agent cannot
 * strand a body in the world. A character is leased at most once, because two
 * bodies loading one .plr would each save over the other.
 *
 * The pool refills itself: whenever fewer than `spares` bodies are ready, it
 * boots another (up to `max`), and a failed body is replaced rather than
 * repaired. Nothing here retries a body in place — a client that failed once
 * is in a state nobody has characterised.
 */
export function Pool(opts: PoolOpts) {
    const spares = opts.limits?.spares ?? DEFAULTS.spares
    const maxBodies = opts.limits?.max ?? DEFAULTS.max
    const settleMs = opts.limits?.settleMs ?? DEFAULTS.settleMs
    const sweepMs = opts.sweepMs ?? SWEEP_MS
    const bodies = new Map<string, BodyHandle>()
    const leases = new Map<string, Lease>()
    /** Where each leased body speaks the body contract, by lease. */
    const endpoints = new Map<string, EndpointT>()
    let slots = 0
    let sweeping: ReturnType<typeof setInterval> | null = null
    const notices: Notice[] = []
    let bootFailures = 0
    /** When a body last entered a world — the start of its settling window. */
    let lastEmbodiedAt = 0
    /** Why the pool stopped refilling, until someone asks it to try again. */
    let halted: string | null = null

    function leaseOf(body: string): Lease | null {
        for (const lease of leases.values()) if (lease.body === body) return lease
        return null
    }

    /** Freeze a warm body nobody is in — see Rest. Called whenever one becomes idle, and by the sweep as a backstop. */
    function idle(body: BodyHandle): void {
        if (body.state === "ready" && !leaseOf(body.id) && !body.resting) body.rest()
    }

    function notice(text: string): void {
        notices.push({ at: new Date().toISOString(), text: text })
        notices.splice(0, notices.length - NOTICES_KEPT)
    }

    function spawn(): BodyHandle {
        const slot = ++slots
        const body = opts.body({ id: `body-${slot}`, slot: slot })
        bodies.set(body.id, body)
        void body.boot().then(
            () => {
                bootFailures = 0
                idle(body)
            },
            cause => {
                if (body.state === "stopped") return
                const reason = `${body.id}: ${cause instanceof Error ? cause.message : String(cause)}`
                notice(reason)
                bootFailures += 1
                if (bootFailures >= MAX_BOOT_FAILURES) halted = `bodies failed to boot ${bootFailures} times in a row — last: ${reason}`
            },
        )
        return body
    }

    /**
     * Retire idle bodies beyond `spares`. An agent leaving hands its body back
     * warm, and the spare booted while it was leased is still there — without
     * this, every lease-and-release grows the pool by one.
     */
    async function trim(): Promise<void> {
        const idle = [...bodies.values()].filter(body => body.state === "ready" && !leaseOf(body.id))
        for (const body of idle.slice(spares)) {
            bodies.delete(body.id)
            await body.stop()
        }
    }

    /** Keep `spares` ready bodies, within `max`, and never while one is still settling. */
    function refill(): void {
        if (!opts.world() || halted) return
        // A body that just entered the world is doing its heaviest work. Let it
        // finish before committing a core to booting another.
        if (settling()) return
        const warm = [...bodies.values()].filter(body => body.state === "ready" || body.state === "booting").length
        let live = [...bodies.values()].filter(body => body.state !== "failed").length
        for (let needed = spares - warm; needed > 0 && live < maxBodies; needed--, live++) spawn()
    }

    /** Is any body still inside its settling window, or mid-join? */
    function settling(): boolean {
        if ([...bodies.values()].some(body => body.state === "joining")) return true
        if (settleMs <= 0) return false
        return Date.now() - lastEmbodiedAt < settleMs
    }

    /** End a lease, saying why: a body taken from an agent that still runs is otherwise a mystery to it. */
    async function release(id: string, why: string): Promise<void> {
        const lease = leases.get(id)
        if (!lease) throw err("WORLD_LEASE_UNKNOWN", { detail: id })
        leases.delete(id)
        const endpoint = endpoints.get(id)
        endpoints.delete(id)
        await endpoint?.close()
        notice(`${lease.body} released from ${lease.agent} (${lease.identity}): ${why}`)
        const body = bodies.get(lease.body)
        if (body && body.state !== "failed") {
            await body.leave({ stateDir: lease.stateDir })
            idle(body)
        }
    }

    /** Reclaim bodies from dead agents; replace failed bodies. */
    async function sweep(): Promise<void> {
        for (const lease of [...leases.values()]) {
            if (alive(lease.pid)) continue
            await release(lease.id, `its process ${lease.pid} is gone`).catch(cause => {
                notice(`releasing ${lease.body} from dead agent ${lease.agent}: ${cause instanceof Error ? cause.message : String(cause)}`)
            })
        }
        for (const body of [...bodies.values()]) {
            if (body.state !== "failed") {
                idle(body)
                await body.prune()
                continue
            }
            const lease = leaseOf(body.id)
            if (lease) {
                leases.delete(lease.id)
                notice(`${body.id} failed under ${lease.agent} (${lease.identity}): ${body.info(null, null).error ?? "no reason given"} — its agent must lease another`)
            }
            bodies.delete(body.id)
            await body.stop()
        }
        await trim()
        refill()
    }

    return {
        /** Start keeping bodies warm for the running world. */
        start(): void {
            halted = null
            bootFailures = 0
            notices.splice(0)
            if (sweeping) return
            refill()
            sweeping = setInterval(() => {
                void sweep().catch(cause => notice(`sweep: ${cause instanceof Error ? cause.message : String(cause)}`))
            }, sweepMs)
        },

        list(): BodyInfo[] {
            return [...bodies.values()].map(body => {
                const lease = leaseOf(body.id)
                return body.info(lease ? { id: lease.id, agent: lease.agent } : null, lease?.world ?? null)
            })
        },

        /** Why the pool stopped booting bodies, or null while it is healthy. */
        halted(): string | null {
            return halted
        },

        leases(): Lease[] {
            return [...leases.values()]
        },

        /** Problems the pool recovered from since the world started, oldest first. */
        notices(): Notice[] {
            return [...notices]
        },

        /** Boot one more warm body now, within the cap. Also how a halted pool is asked to try again. */
        add(input?: { body?: string }): BodyInfo {
            if (input?.body !== undefined) throw err("WORLD_BODY_UNKNOWN", { detail: `this lab's bodies are all one kind; there is no body ${input.body} to add` })
            if (!opts.world()) throw err("WORLD_NOT_RUNNING", { detail: "start a world before adding bodies" })
            halted = null
            bootFailures = 0
            const live = [...bodies.values()].filter(body => body.state !== "failed").length
            if (live >= maxBodies) throw err("WORLD_NO_BODY", { detail: `the pool is at its limit of ${maxBodies} bodies` })
            return spawn().info(null, null)
        },

        /**
         * Put an agent in a body, as its character. Waits for a warm body if
         * one is still booting; the pool refills behind it.
         */
        async lease(input: LeaseInput): Promise<Embodiment> {
            // A pool's bodies are all one kind: a request for a particular one is a mistake to say, not to ignore.
            if (input.body !== undefined) throw err("WORLD_BODY_UNKNOWN", { detail: `this lab's bodies are all one kind; there is no body ${input.body} to choose` })
            if (input.scenario) throw err("WORLD_REFUSED", { detail: "a scenario is a run, not a lease — it is started through the lab's runs, which place the agent themselves" })
            // The address names where to be: that world is served if it is not
            // already. Naming none means the one running, and none running is
            // refused rather than guessed at.
            const world = input.world ? await opts.start({ name: input.world }) : opts.world()
            if (!world || world.state !== "running") throw err("WORLD_NOT_RUNNING", { detail: "no world is running, and this address names none to start — say which: world://localhost/<lab>/<world>" })
            for (const held of leases.values()) {
                if (held.identity === input.identity) {
                    throw err("WORLD_CHARACTER_LEASED", { detail: `${input.identity} is embodied by ${held.agent} in ${held.body}`, context: { identity: input.identity } })
                }
            }

            refill()
            const deadline = Date.now() + WAIT_MS
            let body: BodyHandle | undefined
            while (!(body = [...bodies.values()].find(candidate => candidate.state === "ready" && !leaseOf(candidate.id)))) {
                if (halted) throw err("WORLD_NO_BODY", { detail: halted })
                if (Date.now() > deadline) throw err("WORLD_NO_BODY", { detail: `no body was ready within ${WAIT_MS / 1000}s` })
                if (![...bodies.values()].some(candidate => candidate.state === "booting")) refill()
                await Bun.sleep(250)
            }

            const lease: Lease = {
                id: randomUUID(),
                body: body.id,
                world: world.name,
                agent: input.agent,
                pid: input.pid,
                identity: input.identity,
                stateDir: input.stateDir,
                at: new Date().toISOString(),
            }
            leases.set(lease.id, lease)
            let opened: { url: string; token: string }
            try {
                body.wake()
                await body.join({ identity: input.identity, stateDir: input.stateDir, world: world })
                lastEmbodiedAt = Date.now()
                // Opened once the body is in a world, so the first thing a mind hears from it is what it is.
                const endpoint = opts.endpoint(body)
                endpoints.set(lease.id, endpoint)
                opened = await endpoint.open()
            } catch (cause) {
                leases.delete(lease.id)
                await endpoints.get(lease.id)?.close()
                endpoints.delete(lease.id)
                throw cause
            }
            refill()
            return { lease: lease.id, body: body.id, world: world.name, identity: input.identity, endpoint: opened.url, token: opened.token }
        },

        /** An agent handing its body back. */
        release(id: string): Promise<void> {
            return release(id, "its agent handed it back")
        },

        /**
         * Everyone out, every body stopped. Durable state is handed back
         * before its body stops; one that cannot be is reported, not dropped,
         * and the rest still stop.
         */
        async stop(): Promise<void> {
            if (sweeping) clearInterval(sweeping)
            sweeping = null
            const problems: string[] = []
            for (const lease of [...leases.values()]) {
                await release(lease.id, "the lab stopped").catch(cause => problems.push(`${lease.identity}: ${cause instanceof Error ? cause.message : String(cause)}`))
            }
            await Promise.all([...bodies.values()].map(body => body.stop()))
            bodies.clear()
            if (problems.length > 0) throw err("WORLD_BODY_FAILED", { detail: `stopped, but durable state may not have saved: ${problems.join("; ")}` })
        },
    }
}

export type PoolT = ReturnType<typeof Pool>
