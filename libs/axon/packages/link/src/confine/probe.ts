import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"

/**
 * Probe — the OS facts confinement needs, and nothing else. Ambient knowledge
 * only; no capsule logic, no side effects beyond reading the system. Never
 * throws — it reports; the orchestrator decides whether the report is fatal.
 *
 * Absorbs what the old setuid-runner check did: there is no runner binary any
 * more, so "can this host confine?" is "are the composed tools present and does
 * the confinement user exist?".
 */

/**
 * Resolve the runtime entrypoint the box execs.
 *
 * A FUNCTION taking the candidate locations, not a module constant reading its
 * own `import.meta.dir`. Confinement is a platform concern and knows nothing
 * about what it is confining — the caller owns which program goes in the box,
 * which is what lets the same builder confine the capsule subprocess today and
 * the whole agent process after the reshuffle.
 *
 * Getting this wrong is total in production: the box tries to exec a path that
 * does not exist and every boot fails ("Module not found"). So it throws on an
 * empty candidate list rather than returning something unusable.
 */
export function entrypoint(candidates: string[]): string {
    const found = candidates.find(candidate => existsSync(candidate))
    if (found) return found
    // No silent fallback: a missing entrypoint must fail here, where the paths
    // that were tried can be named, rather than as an exec error inside a box.
    throw new Error(`CONFINE_ENTRYPOINT_MISSING: none of [${candidates.join(", ")}] exists`)
}

/** The dedicated unprivileged user confinement runs the subprocess as. */
export const CONFINE_USER = "axon-agent"

export type ProbeStatus = {
    isLinux: boolean
    /** bubblewrap — mount/pid/ipc/net namespaces (+ uid drop on hardened). */
    bwrap: boolean
    /** systemd-run — cgroup v2 scope for resource limits. */
    systemd: boolean
    /**
     * nft — the egress filter itself.
     *
     * No longer hardened-only. nftables inside a user+network namespace manages
     * that namespace's own tables and needs no privilege, so per-host filtering
     * belongs to the rootless `auto` tier. It was gated behind `hardened` on the
     * assumption that a privileged helper was required; it is not.
     */
    nft: boolean
    /** slirp4netns — the userspace network stack a filtered box reaches through. */
    slirp: boolean
    /**
     * capsh — drops the box's capabilities once its ruleset is installed.
     *
     * Required, not optional: a filtered box is granted CAP_NET_ADMIN to build
     * its own filter, and an agent that keeps it can delete that filter. No
     * capsh means no drop, which means an escapable box — so a `net` policy on
     * a host without it is a boot error rather than a weaker box.
     */
    capsh: boolean
    /** Filtered egress is available — a `net` allowlist can actually be enforced. */
    network: boolean
    /** The dedicated confinement user exists (hardened only; `axon install`). */
    userExists: boolean
    /** Rootless containment is available — needs only bwrap + systemd, no root. */
    auto: boolean
    /** Privileged containment is available — auto + nft + the confinement user. */
    hardened: boolean
}

function has(command: string, arg: string): boolean {
    return spawnSync(command, [arg], { stdio: "ignore" }).status === 0
}

function userExists(user: string): boolean {
    return spawnSync("id", [user], { stdio: "ignore" }).status === 0
}

/** Readiness of each confinement tier on this host. Never throws. */
export function probe(user: string = CONFINE_USER): ProbeStatus {
    const isLinux = process.platform === "linux"
    if (!isLinux) {
        return {
            isLinux: false,
            bwrap: false,
            systemd: false,
            nft: false,
            slirp: false,
            capsh: false,
            network: false,
            userExists: false,
            auto: false,
            hardened: false,
        }
    }

    const bwrap = has("bwrap", "--version")
    const systemd = has("systemd-run", "--version")
    const nft = has("nft", "--version")
    const slirp = has("slirp4netns", "--version")
    const capsh = has("capsh", "--help")
    const user_ = userExists(user)

    const auto = bwrap && systemd
    return {
        isLinux,
        bwrap,
        systemd,
        nft,
        slirp,
        capsh,
        // A filtered box needs ALL THREE: no route without a userspace stack,
        // no filter without nft, and no way to drop the capability that would
        // let the agent delete the filter without capsh. Any one missing means
        // a `net` policy cannot be enforced — a boot error, never a fallback to
        // unfiltered egress.
        network: nft && slirp && capsh,
        userExists: user_,
        auto,
        hardened: auto && nft && user_,
    }
}

/** Is the requested tier available on this host? */
export function tierReady(tier: "auto" | "hardened", status: ProbeStatus = probe()): boolean {
    return tier === "auto" ? status.auto : status.hardened
}
