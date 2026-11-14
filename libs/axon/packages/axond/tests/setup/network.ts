import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Store } from "@arcforge/platform/store"
import { Axond, AxonDaemon, type AxondT, type AxonDaemonT } from "../../src/index"
import { TEST_USER, TEST_VERSION } from "./user"

type User = { id: string; email: string; apiKey: string }

/** One box on the simulated network: a real daemon, serving on its own socket. */
export type SimMachine = {
    name: string
    /** The daemon, in-process — for reaching its domains directly. */
    axond: AxondT
    /** A client over its socket — what an application on that box holds. */
    client: AxonDaemonT
    /** Its whole world: socket, store, records. Nothing outside this is read or written. */
    root: string
    /** Its signed-in user, or null for a box nobody has logged into. */
    user: User | null
}

/**
 * Network — several machines, each a real daemon, in one test process.
 *
 * Every machine is isolated to its own scratch root (`DaemonPaths.isolated`):
 * its own store and login, its own running records, its own socket. Two
 * daemons here share a host and a process and nothing else, so a test can
 * tell one box from another exactly as it could on two computers.
 *
 * Machines are signed in as `TEST_USER` unless told otherwise; `user: null`
 * is a box nobody has logged into, and `OTHER_USER` is someone else's box.
 * `network: true` joins it to the machine network in offline mode — a real
 * `axon-net` sidecar dialing other machines directly over loopback. It needs
 * the sidecar built (`cargo build` in libs/axon/packages/net).
 *
 * Always `dispose()` — in a `finally` or `afterEach`. A daemon left serving
 * holds its socket and its timers for the rest of the run.
 */
export function Network() {
    const machines: SimMachine[] = []

    return {
        /** Boot one more machine and wait until it is serving. */
        async machine(name: string, opts: { user?: User | null; network?: boolean } = {}): Promise<SimMachine> {
            // Short: unix socket paths are capped near 108 bytes, and two live here.
            const root = await mkdtemp(join(tmpdir(), `axn-${name.slice(0, 8)}-`))
            const user = opts.user === undefined ? TEST_USER : opts.user
            const axond = Axond({
                root: root,
                version: TEST_VERSION,
                // Offline: real iroh, direct over loopback — no relay, no internet.
                // A short dial timeout: an absent machine on loopback is absent at once.
                // No directory cache: a removal must be seen by the very next request.
                ...(opts.network === true ? { network: { mode: "offline" as const, dialTimeoutMs: 1_000, directoryTtlMs: 0 } } : {}),
            })
            if (user !== null) {
                Store({ root: axond.paths.store }).profiles.save(user.id, {
                    user: { id: user.id, email: user.email },
                    auth: { apiKey: user.apiKey },
                })
            }
            await axond.serve()
            const machine: SimMachine = { name: name, axond: axond, client: AxonDaemon({ root: root }), root: root, user: user }
            machines.push(machine)
            return machine
        },

        /** Every machine booted so far, in order. */
        get machines(): readonly SimMachine[] {
            return machines
        },

        /** Shut every daemon down and remove its root. */
        async dispose(): Promise<void> {
            const all = machines.splice(0)
            await Promise.all(all.map(machine => machine.axond.shutdown()))
            await Promise.all(all.map(machine => rm(machine.root, { recursive: true, force: true })))
        },
    }
}

export type NetworkT = ReturnType<typeof Network>
