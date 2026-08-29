import { readlinkSync } from "node:fs"

/**
 * Finding the process that is actually INSIDE the box's network namespace.
 *
 * ── Why this is not just the spawned pid ────────────────────────────────────
 *
 * `slirp4netns` joins a namespace by PID, and the pid returned by spawning the
 * box is the WRONG one. The command is nested —
 * `systemd-run --scope … bwrap … -- launcher` — and every wrapper in that chain
 * stays in the host's namespaces: `systemd-run` execs into the scope, bwrap
 * forks and it is the CHILD that lands in the new namespaces. Measured: the
 * spawned pid reports the same `net:[…]` inode as the supervisor itself, while
 * its descendant reports a different one.
 *
 * Handing slirp the outer pid fails as `setns(CLONE_NEWNET): Operation not
 * permitted` — which reads like a privilege problem and is a pid problem. The
 * box then never gets a tap device, the in-box launcher times out waiting for
 * one, and the agent never starts. A confined agent with a `net` policy simply
 * would not boot.
 *
 * ── How the right one is identified ─────────────────────────────────────────
 *
 * By NAMESPACE INODE, not by depth. Counting hops would encode the current
 * wrapper chain — add `systemd-run`, drop it for a container tier, and the
 * count is silently wrong. The invariant that actually holds is "the first
 * descendant whose network namespace differs from ours", which stays true
 * however the wrappers change.
 */

/** This process's network namespace, as the `net:[…]` link target. */
function netnsOf(pid: number | "self"): string | null {
    try {
        return readlinkSync(`/proc/${pid}/ns/net`)
    } catch {
        // The process exited, or /proc is not readable for it. Either way it is
        // not the one we are looking for.
        return null
    }
}

/** Direct children of one pid. */
function childrenOf(pid: number): number[] {
    const out = Bun.spawnSync(["pgrep", "-P", String(pid)])
    return new TextDecoder()
        .decode(out.stdout)
        .split("\n")
        .map(line => Number(line.trim()))
        .filter(value => Number.isInteger(value) && value > 0)
}

export type NetnsOpts = {
    /** How long to wait for the box's process to appear. */
    timeoutMs?: number
}

/**
 * Wait for the descendant of `outer` that lives in a different network
 * namespace, and return its pid.
 *
 * Polls because the process does not exist the instant the spawn returns —
 * `systemd-run` has to create the scope and bwrap has to fork before there is
 * anything to find. Returns null on timeout rather than throwing, so the caller
 * can attach a cause to the boot failure it is already reporting.
 */
export async function boxedPid(outer: number, opts: NetnsOpts = {}): Promise<number | null> {
    const deadline = Date.now() + (opts.timeoutMs ?? 5_000)
    const ours = netnsOf("self")

    while (Date.now() < deadline) {
        const found = search(outer, ours, new Set())
        if (found !== null) return found
        await new Promise(resolve => setTimeout(resolve, 25))
    }
    return null
}

/**
 * Depth-first walk for the first descendant in a different netns.
 *
 * `seen` guards against a pid appearing twice in a reparented tree — a cycle
 * here would hang the boot path rather than fail it.
 */
function search(pid: number, ours: string | null, seen: Set<number>): number | null {
    if (seen.has(pid)) return null
    seen.add(pid)

    for (const child of childrenOf(pid)) {
        const ns = netnsOf(child)
        if (ns !== null && ns !== ours) return child
        const deeper = search(child, ours, seen)
        if (deeper !== null) return deeper
    }
    return null
}
