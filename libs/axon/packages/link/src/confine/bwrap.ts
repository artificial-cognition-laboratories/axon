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
 * Network has three states, not two. No `net` policy at all → `--unshare-net`,
 * and the box has no network stack whatsoever. A `net` policy → the box gets
 * its own network namespace, which `Network()` then furnishes with a userspace
 * stack and a default-drop nft ruleset. `isolation: "none"` → the host's
 * network, unfiltered.
 *
 * The middle case used to be missing: any grant handed over the host's full
 * network, so a policy naming one host reached every host. `--unshare-net` is
 * emitted in BOTH confined cases now — the namespace is what the filter needs
 * to exist in, so asking for filtered egress and asking for none begin the
 * same way and diverge in what is attached afterwards.
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
        ]

        /**
         * The box's scratch space, optionally capped.
         *
         * `--size` applies to the NEXT `--tmpfs`, so the pair must stay adjacent
         * and in this order. This is the only place a disk bound can be
         * expressed: cgroup v2 has no space controller, and a bind-mounted grant
         * is backed by a real filesystem whose size this cannot govern.
         */
        if (spec.limits.disk !== null) a.push("--size", String(sizeBytes(spec.limits.disk)))
        a.push("--tmpfs", "/tmp")

        // Hardened tier only: drop to a dedicated uid/gid. A custom uid needs a
        // user namespace, and mapping to a *different* real user needs privilege
        // — so rootless "auto" never takes this path.
        if (spec.tier === "hardened" && spec.uid !== null && spec.gid !== null) {
            a.push("--unshare-user", "--uid", String(spec.uid), "--gid", String(spec.gid))
        }

        /**
         * A FILTERED box needs a user namespace it is root in, plus
         * CAP_NET_ADMIN — and it needs them for one reason only: nftables
         * refuses to manage a namespace's tables without it.
         *
         * Measured, not assumed. `unshare --map-root-user --net` installs the
         * ruleset fine; bwrap with the same uid map does not, and the two
         * differ in exactly one observable: bwrap drops every capability
         * (`CapEff: 0000000000000000` against unshare's full set). nft then
         * fails with "cache initialization failed: Operation not permitted"
         * and — correctly — the launcher refuses to start the agent.
         *
         * The capability is scoped to the box's OWN network namespace. It
         * confers nothing on the host: the process is root only inside a user
         * namespace it created, and the only network it can administer is the
         * empty one it was just given. It is the minimum needed to build a wall
         * around yourself.
         */
        if (spec.network !== null) {
            a.push("--unshare-user", "--uid", "0", "--gid", "0", "--cap-add", "CAP_NET_ADMIN")
            /**
             * CAP_SETPCAP exists only so the launcher can GIVE IT ALL UP.
             *
             * Dropping the bounding set requires it, and without the drop the
             * agent keeps CAP_NET_ADMIN and can `nft flush ruleset` its own
             * wall away — measured: a blocked host returned 301 after the
             * flush. So this is granted to the launcher purely so it can hand
             * back everything, including this, before the agent starts. See
             * netup.ts, where the order is the security property.
             */
            a.push("--cap-add", "CAP_SETPCAP")
        }

        // The box ALWAYS gets its own network namespace under confinement.
        // With no `net` policy that is the whole story: no stack, no egress.
        // With one, the orchestrator attaches a userspace stack and an nft
        // ruleset to this namespace — which cannot be done without it.
        a.push("--unshare-net")

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

        // The box's own resolver file, when DNS is filtered to the allowlist:
        // names that were granted resolve, and nothing else exists to look up.
        if (spec.hosts !== null) a.push("--ro-bind", spec.hosts, "/etc/hosts")

        // Supervisor plumbing — the link socket directory. Read-write because
        // the agent connects (and a unix socket connect needs write on the
        // directory entry). This is the ONE hole punched through an otherwise
        // deny-by-default filesystem, and it is deliberate: without it the
        // agent cannot reach its supervisor at all, since Bun.spawn cannot
        // hand it a pre-connected fd.
        for (const path of spec.control) a.push("--bind", path, path)

        // Auto-bind the host cwd read-write ONLY when no fs policy is declared.
        // With a policy present, binding cwd would silently expose the whole
        // invocation tree and defeat the policy — the declared paths are all
        // that exist.
        if (spec.bindCwd) a.push("--bind", spec.cwd, spec.cwd)

        a.push("--chdir", spec.workdir)

        /**
         * THE ENVIRONMENT STARTS EMPTY.
         *
         * `--clearenv` is the whole of this fix and it was the whole of the
         * hole. bwrap inherits the parent's environment by default, and the two
         * `--setenv` calls below only OVERRODE two names on top of it — so every
         * variable in the invoking shell crossed into the box. An `fs` policy
         * would carefully deny reading `.env` off disk while the same secrets
         * arrived as environment, readable by any model-emitted line.
         *
         * What follows is built from nothing: the floor below, then the agent's
         * own `.env`, then whatever `policy.env.allow` names. A variable that is
         * in none of those does not exist inside the box.
         */
        a.push("--clearenv")

        // The floor. HOME points at the tmpfs so any tool that writes a dotfile
        // stays inside the box; PATH covers the bound system dirs (the
        // interpreter itself is referenced by absolute path). Not grants — the
        // box cannot start without them, and `axon policy` never lists them as
        // though the user had asked.
        a.push("--setenv", "HOME", "/tmp")
        a.push("--setenv", "PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        for (const [key, value] of Object.entries(spec.env)) a.push("--setenv", key, value)

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

/**
 * A systemd-style size string as bytes.
 *
 * Accepts the same suffixes `limits.memory` uses, so one policy does not need
 * two size vocabularies. An unsuffixed number is already bytes.
 */
function sizeBytes(size: string): number {
    const match = size.trim().match(/^(\d+(?:\.\d+)?)\s*([KMGT]?)i?B?$/i)
    if (!match) throw new Error(`CAPSULE_LIMIT_INVALID: cannot read "${size}" as a size`)
    const scale = { "": 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }
    return Math.floor(Number(match[1]) * scale[match[2]!.toUpperCase() as keyof typeof scale])
}
