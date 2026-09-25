import { randomUUID } from "node:crypto"
import { err } from "@arcforge/err"
import { Body, type BodyT } from "./body"
import type { InstallT } from "./install"
import { alive, type ProcessesT } from "./processes"
import type { BodyInfo, Lease, LeaseGrant, Notice, RunningWorld } from "./types"

export type BodiesOpts = {
    install: InstallT
    processes: ProcessesT
    /** The world bodies join. Null when none is running — leasing then fails loudly. */
    world(): RunningWorld | null
}

/** Warm bodies kept beyond those leased, so the next agent never waits for a client to boot. */
const SPARES = 1
/** Each client is ~1–1.5GB; this caps what one machine commits to the lab. */
const MAX_BODIES = 4
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
 * Bodies — the pool of warm clients, and who is in which.
 *
 * A lease is an agent's claim on a body for as long as the agent's process
 * lives: the sweep releases it when the pid dies, so a crashed agent cannot
 * strand a body in the world. A character is leased at most once, because two
 * bodies loading one .plr would each save over the other.
 *
 * The pool refills itself: whenever fewer than SPARES bodies are ready, it
 * boots another (up to MAX_BODIES), and a failed body is replaced rather than
 * repaired. Nothing here retries a body in place — a client that failed once
 * is in a state nobody has characterised.
 */
export function Bodies(opts: BodiesOpts) {
    const bodies = new Map<string, BodyT>()
    const leases = new Map<string, Lease>()
    let slots = 0
    let sweeping: ReturnType<typeof setInterval> | null = null
    const notices: Notice[] = []
    let bootFailures = 0
    /** Why the pool stopped refilling, until someone asks it to try again. */
    let halted: string | null = null

    function leaseOf(body: string): Lease | null {
        for (const lease of leases.values()) if (lease.body === body) return lease
        return null
    }

    function notice(text: string): void {
        notices.push({ at: new Date().toISOString(), text: text })
        notices.splice(0, notices.length - NOTICES_KEPT)
    }

    function spawn(): BodyT {
        const body = Body({
            id: `body-${++slots}`,
            slot: slots,
            install: opts.install,
            processes: opts.processes,
        })
        bodies.set(body.id, body)
        void body.boot().then(
            () => { bootFailures = 0 },
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
     * Retire idle bodies beyond SPARES. An agent leaving hands its body back
     * warm, and the spare booted while it was leased is still there — without
     * this, every lease-and-release grows the pool by one.
     */
    async function trim(): Promise<void> {
        const idle = [...bodies.values()].filter(body => body.state === "ready" && !leaseOf(body.id))
        for (const body of idle.slice(SPARES)) {
            bodies.delete(body.id)
            await body.stop()
        }
    }

    /** Keep SPARES ready bodies, within MAX_BODIES. */
    function refill(): void {
        if (!opts.world() || halted) return
        const warm = [...bodies.values()].filter(body => body.state === "ready" || body.state === "booting").length
        let live = [...bodies.values()].filter(body => body.state !== "failed").length
        for (let needed = SPARES - warm; needed > 0 && live < MAX_BODIES; needed--, live++) spawn()
    }

    async function release(id: string): Promise<void> {
        const lease = leases.get(id)
        if (!lease) throw err("WORLD_LEASE_UNKNOWN", { detail: id })
        leases.delete(id)
        const body = bodies.get(lease.body)
        if (body && body.state !== "failed") await body.leave({ characterDir: lease.characterDir })
    }

    /** Reclaim bodies from dead agents; replace failed bodies. */
    async function sweep(): Promise<void> {
        for (const lease of [...leases.values()]) {
            if (alive(lease.pid)) continue
            await release(lease.id).catch(cause => {
                notice(`releasing ${lease.body} from dead agent ${lease.agent}: ${cause instanceof Error ? cause.message : String(cause)}`)
            })
        }
        for (const body of [...bodies.values()]) {
            if (body.state !== "failed") {
                await body.prune()
                continue
            }
            const lease = leaseOf(body.id)
            if (lease) leases.delete(lease.id)
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
            }, SWEEP_MS)
        },

        list(): BodyInfo[] {
            return [...bodies.values()].map(body => {
                const lease = leaseOf(body.id)
                return body.info(lease ? { id: lease.id, agent: lease.agent } : null)
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
        add(): BodyInfo {
            if (!opts.world()) throw err("WORLD_NOT_RUNNING", { detail: "start a world before adding bodies" })
            halted = null
            bootFailures = 0
            const live = [...bodies.values()].filter(body => body.state !== "failed").length
            if (live >= MAX_BODIES) throw err("WORLD_NO_BODY", { detail: `the pool is at its limit of ${MAX_BODIES} bodies` })
            return spawn().info(null)
        },

        /**
         * Put an agent in a body, as its character. Waits for a warm body if
         * one is still booting; the pool refills behind it.
         */
        async lease(input: { agent: string; pid: number; character: string; characterDir: string }): Promise<LeaseGrant> {
            const world = opts.world()
            if (!world || world.state !== "running") throw err("WORLD_NOT_RUNNING", { detail: "start a world from the Worlds view, then boot the agent" })
            for (const held of leases.values()) {
                if (held.character === input.character) {
                    throw err("WORLD_CHARACTER_LEASED", { detail: `${input.character} is embodied by ${held.agent} in ${held.body}`, context: { character: input.character } })
                }
            }

            refill()
            const deadline = Date.now() + WAIT_MS
            let body: BodyT | undefined
            while (!(body = [...bodies.values()].find(candidate => candidate.state === "ready" && !leaseOf(candidate.id)))) {
                if (halted) throw err("WORLD_NO_BODY", { detail: halted })
                if (Date.now() > deadline) throw err("WORLD_NO_BODY", { detail: `no body was ready within ${WAIT_MS / 1000}s` })
                if (![...bodies.values()].some(candidate => candidate.state === "booting")) refill()
                await Bun.sleep(250)
            }

            const lease: Lease = {
                id: randomUUID(),
                body: body.id,
                agent: input.agent,
                pid: input.pid,
                character: input.character,
                characterDir: input.characterDir,
                at: new Date().toISOString(),
            }
            leases.set(lease.id, lease)
            try {
                await body.join({ name: input.character, characterDir: input.characterDir, host: world.host, port: world.port, password: world.password })
            } catch (cause) {
                leases.delete(lease.id)
                throw cause
            }
            refill()
            return { lease: lease.id, body: body.id, world: world.name, bridge: body.bridge, frames: body.frames, audio: body.audio, character: input.character }
        },

        release: release,

        /**
         * Everyone out, every body stopped. Characters are saved back before
         * their bodies stop; one that cannot be is reported, not dropped, and
         * the rest still stop.
         */
        async stop(): Promise<void> {
            if (sweeping) clearInterval(sweeping)
            sweeping = null
            const problems: string[] = []
            for (const lease of [...leases.values()]) {
                await release(lease.id).catch(cause => problems.push(`${lease.character}: ${cause instanceof Error ? cause.message : String(cause)}`))
            }
            await Promise.all([...bodies.values()].map(body => body.stop()))
            bodies.clear()
            if (problems.length > 0) throw err("WORLD_BODY_FAILED", { detail: `stopped, but characters may not have saved: ${problems.join("; ")}` })
        },
    }
}

export type BodiesT = ReturnType<typeof Bodies>
