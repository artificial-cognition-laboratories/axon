import type { AgentUsage, UsagePart } from "@arcforge/types"
import { Accounting, type MachineT } from "../machine"
import type { LabState } from "../labs"

export type UsageOpts = {
    machine: MachineT
    /**
     * Every lab's state, from wherever the labs run. The daemon reads its own;
     * a supervisor a terminal hosts reads the machine daemon's over its
     * socket — the bodies are THERE, and an agent's body is most of what it
     * costs.
     */
    labs: () => Promise<LabState[]>
    /**
     * The process supervising agents — where their local models run — and
     * what it is: the machine `daemon`, or a `terminal` hosting the
     * supervisor in its own process. Named honestly because the two cost
     * different things: a terminal's figure includes drawing itself.
     */
    host: { pid: number; name: "daemon" | "terminal" }
}

/**
 * Usage — what one agent costs the machine, part by part.
 *
 *   brain   the agent's own process tree: its runtime, its cognet, its tools
 *   body    the lab body it is in: the game client and its captures
 *   world   the server that body is in — shared with every other body there
 *   daemon  the supervising process alone: local models run here, shared by
 *   / terminal  every agent using them, with the supervision that serves this one
 *
 * Plus every thread of the brain, so a worker pool's balance — or a main
 * thread pegged while the workers idle — is visible, not inferred. And the
 * machine's busiest processes, whoever's they are: when the machine is full
 * and the parts do not add up to it, that is what says who else is on it.
 *
 * The body is found from LAB STATE, not from the lab objects: a lease names
 * the agent's pid, and a body names its processes. Any process that can read
 * the state can account for a body exactly, which is what lets a supervisor
 * outside the daemon see the body the daemon runs.
 *
 * One sampler per agent, because CPU is a rate and each sampler keeps the
 * previous readings its rates are taken against. While a sampler is open
 * the machine keeps its fast cadence, so the totals beside the parts are
 * as fresh as the parts.
 */
export function Usage(opts: UsageOpts) {
    return {
        of(pid: number) {
            const accounting = Accounting({ attribution: opts.machine.attribution })
            const release = opts.machine.observe()

            return {
                async measure(): Promise<AgentUsage> {
                    const labs = await opts.labs()
                    const family = accounting.family([pid])
                    const { body, world } = embodiment(labs, family)
                    const parts: Record<string, { roots: number[]; shared: boolean; alone?: boolean }> = {
                        brain: { roots: [pid], shared: false },
                        [opts.host.name]: { roots: [opts.host.pid], shared: true, alone: true },
                    }
                    if (body.length > 0) parts.body = { roots: body, shared: false }
                    if (world.length > 0) parts.world = { roots: world, shared: true }
                    const measured: Record<string, UsagePart> = accounting.measure(parts)
                    const threads = accounting.threads([pid])
                    const busiest = accounting.busiest(BUSIEST)

                    const state = opts.machine.state()
                    const usage = state.usage
                    return {
                        at: Date.now(),
                        parts: measured,
                        threads: threads,
                        machine: {
                            cores: state.capacity.cores,
                            cpu: usage.cpuUtil,
                            ram: { used: state.capacity.ram - usage.ramAvailable, total: state.capacity.ram },
                            gpu: usage.gpuUtil,
                            vram: { used: usage.vramUsed, total: state.capacity.vram },
                            busiest: busiest,
                        },
                    }
                },

                close: release,
            }
        },
    }
}

export type UsageT = ReturnType<typeof Usage>

/** How many of the machine's busiest processes a sample names. */
const BUSIEST = 8

/**
 * The processes an agent is using in the labs: every body leased by a pid in
 * its tree — the lease names the runtime deep inside the launch chain, not
 * the process its supervisor started — and the world server of any lab it
 * has a body in.
 */
function embodiment(labs: readonly LabState[], family: ReadonlySet<number>): { body: number[]; world: number[] } {
    const body: number[] = []
    const world: number[] = []
    for (const lab of labs) {
        const held = lab.leases.filter(lease => family.has(lease.pid))
        if (held.length === 0) continue
        const leased = new Set(held.map(lease => lease.body))
        for (const info of lab.bodies) if (leased.has(info.id)) body.push(...info.pids)
        // Only the worlds this family is actually in: a lab may serve several
        // beside each other, and the ones nobody here is in are not its cost.
        const inhabited = new Set(held.map(lease => lease.world))
        for (const running of lab.running) if (running.pid && inhabited.has(running.name)) world.push(running.pid)
    }
    return { body: body, world: world }
}
