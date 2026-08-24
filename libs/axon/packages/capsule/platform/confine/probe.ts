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

// The published CLI ships capsule-process.js bundled beside app.js — a FLAT
// bundle where import.meta.dir is the bundle root, so the artifact sits in the
// same directory (never "../"). In the workspace this file lives at
// platform/confine/, so the .ts source is two dirs up at src/process/main.ts.
// Check the packaged location first (same dir), then fall back to source.
// Getting this wrong is total in production: the box tries to exec a path that
// does not exist and every capsule boot fails ("Module not found").
const packaged = join(import.meta.dir, "capsule-process.js")
export const ENTRYPOINT = existsSync(packaged)
    ? packaged
    : join(import.meta.dir, "../../src/process/main.ts")

/** The dedicated unprivileged user confinement runs the subprocess as. */
export const CONFINE_USER = "axon-agent"

export type ProbeStatus = {
    isLinux: boolean
    /** bubblewrap — mount/pid/ipc/net namespaces (+ uid drop on hardened). */
    bwrap: boolean
    /** systemd-run — cgroup v2 scope for resource limits. */
    systemd: boolean
    /** nft — kernel network allowlisting (hardened only). */
    nft: boolean
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
        return { isLinux: false, bwrap: false, systemd: false, nft: false, userExists: false, auto: false, hardened: false }
    }

    const bwrap = has("bwrap", "--version")
    const systemd = has("systemd-run", "--version")
    const nft = has("nft", "--version")
    const user_ = userExists(user)

    const auto = bwrap && systemd
    return {
        isLinux,
        bwrap,
        systemd,
        nft,
        userExists: user_,
        auto,
        hardened: auto && nft && user_,
    }
}

/** Is the requested tier available on this host? */
export function tierReady(tier: "auto" | "hardened", status: ProbeStatus = probe()): boolean {
    return tier === "auto" ? status.auto : status.hardened
}
