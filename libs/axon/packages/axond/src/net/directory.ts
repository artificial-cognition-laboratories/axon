import { err } from "@arcforge/err"
import type { AxonCloudClient, Machine } from "@arcforge/cloud"
import { machineStatement, type MachineDistribution } from "@arcforge/types"
import type { Peer } from "../control/remote/index"
import type { KeyT } from "../machine/index"

type DirectoryOpts = {
    /** The backend, as the signed-in account. Read at the call: sign-in can change under a running daemon. */
    cloud: () => AxonCloudClient
    /** Who is signed in here, or null. */
    account: () => { id: string } | null
    key: KeyT
    /** How this machine describes itself in the directory. */
    about: () => { name: string; platform: string; arch: string }
    distribution: MachineDistribution
    /** How long a read of the directory is trusted before it is read again. */
    ttlMs: number
}

/**
 * Directory — who is on this account's network, as the backend says.
 *
 * Enrolls this machine and keeps its addresses current, and answers the one
 * question every inbound request needs: does this key belong to the same
 * account, and is it still trusted? Read through a short cache, so a burst of
 * requests is one backend call; a key it has not seen forces a fresh read, so
 * a machine enrolled a moment ago is not refused for a minute. A removal takes
 * effect within one `ttlMs`.
 */
export function Directory(opts: DirectoryOpts) {
    let read: { at: number; account: string; machines: Machine[] } | null = null

    function signedIn(): { id: string } {
        const account = opts.account()
        if (account === null) throw err("NET_REFUSED", { detail: "this machine is not signed in, so it has no network to belong to" })
        return account
    }

    async function refresh(account: string): Promise<Machine[]> {
        const machines = await opts.cloud().user.machines.list(opts.distribution)
        read = { at: Date.now(), account: account, machines: machines }
        return machines
    }

    /** The account's machines, from cache while fresh — or always fresh when `fresh`. */
    async function machines(account: string, fresh: boolean): Promise<Machine[]> {
        const stale = read === null || read.account !== account || Date.now() - read.at > opts.ttlMs
        return fresh || stale ? refresh(account) : read!.machines
    }

    return {
        /** Whether anyone is signed in here — throws when the store cannot be read. */
        signedIn(): boolean {
            return opts.account() !== null
        },

        /** Enroll this machine into the signed-in account's network, or refresh its entry. */
        async enroll(addrs: string[]): Promise<Machine> {
            const account = signedIn()
            const at = new Date().toISOString()
            const key = opts.key.id()
            const statement = machineStatement({ userId: account.id, key: key, distribution: opts.distribution, at: at })
            const machine = await opts.cloud().user.machines.enroll({
                key: key,
                ...opts.about(),
                distribution: opts.distribution,
                addrs: addrs,
                at: at,
                signature: opts.key.sign(statement),
            })
            read = null
            return machine
        },

        /** Report this machine alive, and where it can be reached. */
        async seen(addrs: string[]): Promise<void> {
            signedIn()
            await opts.cloud().user.machines.seen(opts.key.id(), addrs)
        },

        /** This account's machines on this network, removed ones included. */
        async list(): Promise<Machine[]> {
            return machines(signedIn().id, false)
        },

        /**
         * The caller, if it may call: a machine of this account, not removed —
         * and only while THIS machine is itself still trusted. Throws
         * NET_REFUSED naming which of those failed.
         */
        async authorize(key: string): Promise<Peer> {
            const account = signedIn()
            let known = await machines(account.id, false)
            if (!known.some(machine => machine.key === key)) known = await machines(account.id, true)

            const self = known.find(machine => machine.key === opts.key.id())
            if (!self || self.revokedAt !== null) {
                throw err("NET_REFUSED", { detail: "this machine is not on the account's network (not enrolled, or removed)" })
            }
            const caller = known.find(machine => machine.key === key)
            if (!caller) throw err("NET_REFUSED", { detail: `${key.slice(0, 10)}… is not a machine on this account's network` })
            if (caller.revokedAt !== null) throw err("NET_REFUSED", { detail: `${caller.name} was removed from this network` })
            return { machine: key, account: account.id }
        },
    }
}

export type DirectoryT = ReturnType<typeof Directory>
