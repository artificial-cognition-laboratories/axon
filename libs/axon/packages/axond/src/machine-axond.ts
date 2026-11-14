import { Axond } from "./axond"

/**
 * MachineAxond — the daemon that IS this machine, as opposed to one a terminal
 * embeds to supervise its own agents.
 *
 * The one place that says how the machine's daemon is configured, because it
 * has two entry points: `axond` (what `axon daemon up` detaches) and
 * `axon daemon serve` (what the boot unit execs). Each built its own `Axond`,
 * and a setting added to one was silently missing from the other — a daemon
 * started at boot would never have joined the network.
 */
export function MachineAxond(opts: { version: string; entrypoint: string }) {
    return Axond({
        version: opts.version,
        entrypoint: opts.entrypoint,
        // Joins its account's network once signed in. Only the machine's own
        // daemon does — an embedded one is not the machine and must never answer for it.
        network: { mode: "n0" },
    })
}
