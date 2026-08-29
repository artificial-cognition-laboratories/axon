import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { arch, hostname, platform } from "node:os"
import type { MachineIdentity } from "./types"

/**
 * Identity — who this machine is.
 *
 * ── Why an id at all ────────────────────────────────────────────────────────
 *
 * Today there is one daemon and "this machine" is implied. It stops being
 * implied the moment a second daemon is managed from elsewhere: an instance
 * record then has to say WHICH box it runs on, and retrofitting that into
 * records already on disk is a migration. The id costs one file read now.
 *
 * ── Hashed, never raw ───────────────────────────────────────────────────────
 *
 * `/etc/machine-id` and `IOPlatformUUID` are genuine host identifiers, and one
 * of them crossing a wire is a fingerprint nothing here needs. A hash is
 * stable, comparable, and says nothing about the machine it names.
 */
export function Identity() {
    // Read once. It cannot change without a reboot, and re-reading per call
    // would put a file read on the path of every status query.
    const id = probeId()

    return {
        /** This machine, as a record. */
        current(): MachineIdentity {
            return {
                id: id,
                hostname: hostname(),
                platform: platform(),
                arch: arch(),
            }
        },
    }
}

export type IdentityT = ReturnType<typeof Identity>

/**
 * The host's own identifier, hashed — or null when none can be read.
 *
 * Deliberately NOT falling back to a generated value. A random id would look
 * stable within one process and differ across restarts, which silently
 * fragments every record that correlates on it; a null is a fact a caller can
 * act on.
 */
function probeId(): string | null {
    const raw = platform() === "darwin" ? darwinId() : linuxId()
    if (raw === null) return null
    return createHash("sha256").update(raw).digest("hex").slice(0, 32)
}

function linuxId(): string | null {
    // dbus's copy is the fallback: some distributions populate one and symlink
    // the other, and which is primary varies.
    for (const path of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
        try {
            const value = readFileSync(path, "utf-8").trim()
            if (value.length > 0) return value
        } catch {
            // Unreadable is the ordinary case on a locked-down host, not a
            // fault worth reporting — the next candidate, then null.
            continue
        }
    }
    return null
}

function darwinId(): string | null {
    try {
        const probe = Bun.spawnSync(["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"])
        if (probe.exitCode !== 0) return null

        const match = probe.stdout.toString().match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)
        return match?.[1] ?? null
    } catch {
        return null
    }
}
