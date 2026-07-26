import type { ConfinementSpec } from "./spec"

/**
 * Bwrap — turn a confinement spec into the bubblewrap argv that scopes the box:
 * uid/gid drop, a fresh mount namespace with only the declared paths, and
 * pid/ipc/uts isolation. Pure: spec in, argv out, no side effects.
 *
 * The filesystem view is deny-by-default. A path not bound here does not exist
 * inside the box — a forbidden read fails as "no such file", never "permission
 * denied". The runtime (bun + entrypoint) is always present, or the subprocess
 * could not start, and system dirs are read-only so tools resolve. The host cwd
 * is auto-bound read-write ONLY when no fs policy is declared; once a policy is
 * present it is authoritative and only its declared paths exist — see spec.ts
 * (bindCwd/workdir) for why binding cwd under a policy would silently over-grant.
 *
 * Network is on/off only, in the kernel: no `network` grants → `--unshare-net`
 * (the box has no network stack at all). Any `network` grants → the box keeps
 * the host's network. Per-host allowlisting (net namespace + veth + nft) is a
 * privileged operation and a deliberate follow-up; until it lands, network is
 * binary and the mediator's globs are the only per-host distinction.
 *
 * Tier decides the uid posture:
 *   - "auto"     — rootless. Runs as the invoking user; isolation is by
 *                  namespace alone. No uid flags, no user namespace, no privilege.
 *   - "hardened" — drops to a dedicated uid/gid, which needs a user namespace
 *                  (`--unshare-user`) and, to map to a *different* real user,
 *                  host privilege. Only the hardened path emits these.
 */

// Read-only system mounts every box needs so ordinary tools (bun, git, curl,
// shared libs, DNS) resolve. These are the OS, not the user's data — the user's
// home, other users, and secrets are simply never bound.
const SYSTEM_RO = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc/ssl", "/etc/resolv.conf"]

export function Bwrap(spec: ConfinementSpec) {
    function args(): string[] {
        const a: string[] = [
            "--unshare-pid",
            "--unshare-ipc",
            "--unshare-uts",
            "--die-with-parent", // box dies if the host does — no orphaned sandbox
            "--new-session", // detach controlling tty — no TIOCSTI injection
            "--proc", "/proc",
            "--dev", "/dev",
            "--tmpfs", "/tmp",
        ]

        // Hardened tier only: drop to a dedicated uid/gid. A custom uid needs a
        // user namespace, and mapping to a *different* real user needs privilege
        // — so rootless "auto" never takes this path.
        if (spec.tier === "hardened" && spec.uid !== null && spec.gid !== null) {
            a.push("--unshare-user", "--uid", String(spec.uid), "--gid", String(spec.gid))
        }

        // Network: closed unless any destination is declared. Per-host filtering
        // is the deferred privileged path; this is the on/off floor.
        if (spec.network.length === 0) a.push("--unshare-net")

        // Read-only OS. --ro-bind-try skips a source that doesn't exist rather
        // than failing the whole box.
        for (const path of SYSTEM_RO) a.push("--ro-bind-try", path, path)

        // The runtime itself (interpreter binary + source/dependency roots).
        // Without these the box cannot even start the subprocess.
        for (const path of spec.runtime) a.push("--ro-bind", path, path)

        // Declared read-only grants.
        for (const path of spec.fs.read) a.push("--ro-bind", path, path)

        // Declared read-write grants.
        for (const path of spec.fs.write) a.push("--bind", path, path)

        // Auto-bind the host cwd read-write ONLY when no fs policy is declared.
        // With a policy present, binding cwd would silently expose the whole
        // invocation tree and defeat the policy — the declared paths are all
        // that exist.
        if (spec.bindCwd) a.push("--bind", spec.cwd, spec.cwd)

        a.push("--chdir", spec.workdir)

        // A minimal, box-local environment. HOME points at the tmpfs so any tool
        // that writes a dotfile stays inside the box; PATH covers the bound
        // system dirs (the interpreter itself is referenced by absolute path).
        a.push("--setenv", "HOME", "/tmp")
        a.push("--setenv", "PATH", "/usr/bin:/bin:/usr/sbin:/sbin")

        return a
    }

    return {
        /** The bwrap argv, up to but not including the `--` command separator. */
        args,

        /** Wrap an inner command: `bwrap <box args> -- <inner...>`. */
        wrap(inner: string[]): string[] {
            return ["bwrap", ...args(), "--", ...inner]
        },
    }
}

export type BwrapT = ReturnType<typeof Bwrap>
