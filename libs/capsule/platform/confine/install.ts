import { spawnSync } from "node:child_process"
import { err } from "@axon/err"
import { CONFINE_USER, probe } from "./probe"

/**
 * Install — provision the host for the HARDENED confinement tier. The engine
 * behind `axon install`. Idempotent: safe to run repeatedly.
 *
 * Only the hardened tier needs this. Rootless "auto" confinement requires
 * nothing installed beyond bwrap + systemd (ordinary OS packages) and no
 * privileged setup — that is the whole point of the default tier.
 *
 * install() creates the dedicated unprivileged `axon-agent` user the hardened
 * box drops to. It does NOT install the composed tools (bwrap, systemd, nft) —
 * those are OS packages the user installs through their package manager;
 * install() only reports which are missing so `axon install` can say what to add.
 *
 * Creating a system user needs root, so this runs under sudo/root. It fails
 * loud if it cannot: a half-provisioned host must never look ready.
 */

export type InstallResult = {
    userCreated: boolean
    /** Tools still missing after install — the user must package-install these. */
    missing: string[]
    ready: boolean
}

export function install(user: string = CONFINE_USER): InstallResult {
    const before = probe(user)

    let userCreated = false
    if (!before.userExists) {
        const out = spawnSync("useradd", ["--system", "--no-create-home", "--shell", "/usr/sbin/nologin", user], {
            stdio: "pipe",
            encoding: "utf8",
        })
        if (out.status !== 0) {
            throw err("CAPSULE_INSTALL_FAILED", { context: { user, stderr: out.stderr.trim() } })
        }
        userCreated = true
    }

    const after = probe(user)
    const missing: string[] = []
    if (!after.bwrap) missing.push("bubblewrap")
    if (!after.systemd) missing.push("systemd")
    if (!after.nft) missing.push("nftables")

    return { userCreated, missing, ready: after.hardened }
}
