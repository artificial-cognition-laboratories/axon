import { err } from "@arcforge/err"
import type { Machine } from "@arcforge/cloud"
import type { DirectoryT } from "./directory"
import type { NetSocketT, Path } from "./socket"

type MachinesOpts = {
    directory: DirectoryT
    /** This machine's key — so a list can say which entry is here. */
    self: () => string
    request: NetSocketT["request"]
    fetch: NetSocketT["fetch"]
    /** How long since its last report a machine is still taken to be online. */
    onlineMs: number
}

/** One machine on this account's network, as a person sees it. */
export type MachineEntry = {
    key: string
    name: string
    platform: string
    arch: string
    /** This is the machine answering. */
    self: boolean
    /** Reported in recently — a hint, not a promise: it may have just gone. */
    online: boolean
    lastSeenAt: string
}

/**
 * Machines — the other machines on this account's network, and calling them.
 *
 * The local side of the network: what a terminal or Fleet asks this daemon.
 * A call goes only to a machine the directory lists, by the addresses it last
 * reported; one that has not reported in lately fails at once, naming when it
 * was last seen, rather than spending a dial timeout to learn the same thing.
 */
export function Machines(opts: MachinesOpts) {
    function entry(machine: Machine): MachineEntry {
        return {
            key: machine.key,
            name: machine.name,
            platform: machine.platform,
            arch: machine.arch,
            self: machine.key === opts.self(),
            online: Date.now() - Date.parse(machine.lastSeenAt) <= opts.onlineMs,
            lastSeenAt: machine.lastSeenAt,
        }
    }

    return {
        /** Every machine still on the network, this one included. */
        async list(): Promise<MachineEntry[]> {
            return (await opts.directory.list()).filter(machine => machine.revokedAt === null).map(entry)
        },

        /** Call one remote verb on one machine. */
        async request(input: { key: string; path: readonly string[]; arg?: unknown }): Promise<{ value: unknown; path: Path }> {
            const machine = await reachable(input.key)
            return opts.request({ key: machine.key, addrs: machine.addrs }, { path: input.path, arg: input.arg })
        },

        /**
         * One HTTP request to an agent's `/_axon/*` surface on another machine
         * — what attach speaks. The body streams back as it arrives.
         */
        async fetch(key: string, request: { session: string; method: string; path: string; headers: Record<string, string>; body: string | null }): Promise<Response> {
            const machine = await reachable(key)
            return opts.fetch({ key: machine.key, addrs: machine.addrs }, request)
        },
    }

    /** A machine this one may call right now: on the network, and recently seen. Throws why not. */
    async function reachable(key: string): Promise<Machine> {
        const machine = (await opts.directory.list()).find(known => known.key === key)
        if (!machine || machine.revokedAt !== null) {
            throw err("NET_REFUSED", { detail: `${key.slice(0, 10)}… is not a machine on your network`, context: { key: key } })
        }
        if (!entry(machine).online) {
            throw err("NET_UNREACHABLE", { detail: `${machine.name} was last seen ${machine.lastSeenAt}`, context: { key: key } })
        }
        return machine
    }
}

export type MachinesT = ReturnType<typeof Machines>
