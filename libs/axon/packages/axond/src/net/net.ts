import { join } from "node:path"
import type { KeyT } from "../machine/index"
import { binary } from "./binary"
import type { DirectoryT } from "./directory"
import { Sidecar, type SidecarMode } from "./sidecar"
import { Machines } from "./machines"
import { NetSocket, type NetStatus } from "./socket"

type NetOpts = {
    /** The daemon root: both network sockets live here. */
    root: string
    key: KeyT
    directory: DirectoryT
    /** `n0` reaches machines anywhere; `offline` dials direct addresses only. */
    mode: SidecarMode
    /** How long a dial may take before a machine is reported unreachable. */
    dialTimeoutMs: number
    /** How often this machine tells the directory it is alive. */
    heartbeatMs: number
    /** Where network events go — the daemon's log. */
    report: (event: Record<string, unknown>) => void
}

/** Whether this machine belongs to its account's network right now, or why not. */
export type Membership = { state: "member" } | { state: "outside"; problem: string }

/** This machine on the network: up with its address and membership, or down with the reason. */
export type NetState = ({ state: "up"; membership: Membership } & NetStatus) | { state: "down"; problem: string }

/**
 * Net — this machine's connection to the others.
 *
 * Wires the sidecar (the pipe), its socket (how the daemon speaks to it) and
 * the directory (who is on the network). Starting is the service's job, not
 * construction's. Being up and being a member are separate facts and both are
 * reported: a sidecar can be running on a machine the directory has not
 * accepted, and that machine must say so rather than look connected.
 */
export function Net(opts: NetOpts) {
    const sidecar = Sidecar({
        binary: binary,
        key: () => opts.key.file(),
        root: opts.root,
        mode: opts.mode,
        dialTimeoutMs: opts.dialTimeoutMs,
        report: opts.report,
    })
    const socket = NetSocket({ path: join(opts.root, "net.sock") })
    const machines = Machines({
        directory: opts.directory,
        self: () => opts.key.id(),
        request: socket.request,
        fetch: socket.fetch,
        // Three missed heartbeats before a machine reads as offline.
        onlineMs: opts.heartbeatMs * 3,
    })
    let membership: Membership = { state: "outside", problem: "not started" }
    let heartbeat: ReturnType<typeof setInterval> | null = null

    let joining: Promise<void> | null = null

    function outside(cause: unknown): void {
        const problem = cause instanceof Error ? cause.message : String(cause)
        if (membership.state === "outside" && membership.problem === problem) return
        membership = { state: "outside", problem: problem }
        opts.report({ event: "membership.outside", problem: problem })
    }

    /**
     * One step toward being on the network, whatever state it starts from.
     *
     * Signed out: the sidecar is stopped — a machine with no account has no
     * network, and should not be announcing its key to relays. Signed in: the
     * sidecar is up, the machine enrolled if it is not a member yet, and
     * reported in if it is. Run at start, on every heartbeat, and on `join()`,
     * so a login after the daemon started is picked up without a restart.
     */
    async function step(): Promise<void> {
        if (!opts.directory.signedIn()) {
            if (sidecar.running) await sidecar.stop()
            outside(new Error("not signed in"))
            return
        }
        if (!sidecar.running) await sidecar.start()
        const addrs = (await socket.status()).addrs
        if (membership.state === "member") {
            await opts.directory.seen(addrs)
        } else {
            await opts.directory.enroll(addrs)
            membership = { state: "member" }
            opts.report({ event: "membership.joined" })
        }
    }

    /** One step at a time: a heartbeat landing during a join waits for it rather than racing it. */
    function attempt(): Promise<void> {
        joining ??= step().catch(outside).finally(() => { joining = null })
        return joining
    }

    return {
        request: socket.request,
        directory: opts.directory,
        machines: machines,

        /** Begin joining, and keep at it every heartbeat. Never throws: `status()` says how it went. */
        async start(): Promise<void> {
            heartbeat ??= setInterval(() => { void attempt() }, opts.heartbeatMs)
            await attempt()
        },

        /** Take one step now — what `axon login` calls, so joining does not wait for a heartbeat. */
        join: attempt,

        async stop(): Promise<void> {
            if (heartbeat !== null) clearInterval(heartbeat)
            heartbeat = null
            await joining
            await sidecar.stop()
        },

        /** Never throws for a sidecar that is down — that IS the status. */
        async status(): Promise<NetState> {
            if (!sidecar.running) {
                const problem = membership.state === "outside" ? membership.problem : null
                return { state: "down", problem: problem ?? sidecar.problem ?? "not started" }
            }
            return { state: "up", membership: membership, ...(await socket.status()) }
        },
    }
}

export type NetT = ReturnType<typeof Net>
