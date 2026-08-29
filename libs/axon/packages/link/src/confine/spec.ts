import { statSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import type { CapsulePolicy } from "@arcforge/types"

/**
 * ConfinementSpec — the strict, normalized form of the confinement-relevant
 * slice of CapsulePolicy. Local to this module: nothing outside constructs one.
 * Callers pass a CapsulePolicy; `fromPolicy()` narrows it here, at the one seam,
 * so every builder downstream trusts fully-resolved fields with no `?? default`.
 */
export type ConfinementSpec = {
    /**
     * Which containment tier is being built. "auto" is rootless (namespaces as
     * the invoking user, user cgroups); "hardened" adds uid drop + system
     * cgroups + kernel network rules and requires privilege. The builders read
     * this to decide whether to emit the privileged flags.
     */
    tier: "auto" | "hardened"
    /** The unprivileged user the box drops to — hardened tier only. */
    user: string | null
    /** Numeric uid/gid for the drop — hardened tier only, else null. */
    uid: number | null
    gid: number | null
    /**
     * The box's working directory (--chdir). When no fs policy is declared this
     * is the host cwd, auto-bound read-write (see bindCwd). When an fs policy IS
     * declared the policy is authoritative — cwd is NOT auto-bound, and workdir
     * becomes the first declared writable (else readable) path, so the box still
     * has a real directory to start in without punching a hole through the policy.
     */
    workdir: string
    /**
     * Whether to auto-bind the host cwd read-write. True only when no fs policy
     * is declared. When fs is declared, binding cwd would silently expose the
     * whole invocation tree (e.g. a sibling ./secret) and defeat the policy — so
     * only the declared paths are bound.
     */
    bindCwd: boolean
    /** Host invocation directory. Bound only when bindCwd is true. */
    cwd: string
    /** Absolute path to the runtime entrypoint — always mounted read-only. */
    entrypoint: string
    /**
     * Paths the runtime itself needs to exist inside the box or it cannot start:
     * the interpreter binary and the source/dependency roots the entrypoint
     * imports from. Mounted read-only. Without these, bwrap fails with
     * "execvp bun: No such file or directory".
     */
    runtime: string[]

    fs: {
        /** Paths mounted read-only (beyond the always-on system + runtime base). */
        read: string[]
        /** Paths mounted read-write (beyond cwd). */
        write: string[]
    }

    /**
     * Paths the SUPERVISOR requires inside the box, independent of policy.
     *
     * Today this is the link socket directory. `Bun.spawn` exposes stdio only,
     * so a pre-connected socket fd cannot be inherited and the agent must dial
     * by path — which means the path has to exist inside an otherwise
     * deny-by-default filesystem.
     *
     * Separate from `fs.write` deliberately, and never merged into it: these
     * are the runtime's own plumbing, not a grant the user authored. Keeping
     * them distinct means `axon policy` can render what the USER allowed
     * without a socket directory appearing in the list as though they had
     * asked for it, and a reader of this spec can tell the two apart.
     */
    control: string[]

    /**
     * Network egress, already resolved to what the kernel can enforce.
     *
     * `null` means NO NETWORK AT ALL — the box gets `--unshare-net` and has no
     * stack whatsoever. A present object means a network namespace with a
     * userspace stack and a default-DROP nft ruleset carrying these rules.
     *
     * Hostnames are gone by this point: they were resolved when the spec was
     * built and only addresses remain, because nftables matches packets on
     * address and port. That resolution is the one lossy step in the whole
     * policy path, and it is done HERE, at the seam, so the builders below
     * never hold a name they cannot enforce.
     */
    network: NetworkSpec | null
    /**
     * Path to the `/etc/hosts` the box sees, or null to inherit the system's.
     *
     * Written by the orchestrator when `dns: "allowlist"` — the file IS the
     * resolver in that mode, so it is a build artefact rather than a policy
     * field, and it is bound read-only like any other system mount.
     */
    hosts: string | null
    /**
     * The environment the box receives, already resolved.
     *
     * Built by the orchestrator from the agent's `.env` and `policy.env.allow`;
     * the runtime floor (HOME/PATH) is added by the builder itself. Empty is a
     * valid and common value — the box is `--clearenv`'d, so absence here means
     * the agent genuinely receives nothing beyond the floor.
     */
    env: Record<string, string>

    limits: {
        /** Hard memory cap as a systemd size string, or null for unlimited. */
        memory: string | null
        /** CPU quota (systemd CPUQuota form, e.g. "50%"), or null. */
        cpu: string | null
        /** Max processes/threads in the tree, or null. */
        pids: number | null
        /** Wall-clock ceiling (systemd time span, e.g. "30m"), or null. */
        wall: string | null
        /** Size cap for the box's own tmpfs, or null for the default. */
        disk: string | null
    }
}

/**
 * One egress rule as nftables will express it: an address (or CIDR) and an
 * optional port. A rule with no port matches every port on that address.
 */
export type NetRule = {
    address: string
    port?: number
    /** The hostname this came from, for the audit record and error messages. */
    host?: string
}

export type NetworkSpec = {
    allow: NetRule[]
    deny: NetRule[]
    dns: "allowlist" | "open" | "off"
    /** Names that resolved to nothing — reported, never silently dropped. */
    unresolved: string[]
}

/** The first entry that is an existing directory, or undefined. */
function firstDirectory(paths: string[]): string | undefined {
    return paths.find(path => {
        try {
            return statSync(path).isDirectory()
        } catch {
            // A path that does not exist yet is not a workdir candidate. It may
            // still be a valid grant — bwrap creates the mountpoint — but the
            // box cannot start in it.
            return false
        }
    })
}

type FromPolicyOpts = {
    policy: CapsulePolicy
    tier: "auto" | "hardened"
    cwd: string
    entrypoint: string
    runtime: string[]
    /** Supervisor plumbing that must exist in the box — the link socket dir. */
    control?: string[]
    /**
     * Egress rules, already resolved from hostnames to addresses by the caller.
     *
     * Passed in rather than computed here because resolution is a DNS lookup —
     * real I/O, which `fromPolicy` (a pure narrowing seam) must not do. The
     * orchestrator owns the effectful step; this function stays a projection.
     */
    network?: NetworkSpec | null
    /** Path to a generated hosts file, when DNS is filtered. */
    hosts?: string | null
    /** The resolved environment — agent `.env` plus granted host variables. */
    env?: Record<string, string>
    /** The uid drop, resolved by the orchestrator — hardened only, else null. */
    user?: string | null
    uid?: number | null
    gid?: number | null
}

/** Narrow a CapsulePolicy into a ConfinementSpec. The one normalization seam. */
export function fromPolicy(opts: FromPolicyOpts): ConfinementSpec {
    const { policy } = opts
    // fs paths are authored relative to the agent (e.g. "./workspace") but bwrap
    // resolves --bind against its own cwd. Resolve every declared path against
    // the capsule cwd HERE, at the one seam, so builders only ever see absolute
    // paths and nothing downstream re-guesses the base.
    const abs = (p: string) => (isAbsolute(p) ? p : resolve(opts.cwd, p))
    const read = (policy.fs?.read ?? []).map(abs)
    const write = (policy.fs?.write ?? []).map(abs)

    // An fs policy makes the declared paths authoritative: cwd is not auto-bound
    // (that would expose the whole invocation tree), and the box starts in the
    // first writable declared path — or first readable, if it's read-only.
    const fsDeclared = read.length > 0 || write.length > 0
    /**
     * The box has to start in a DIRECTORY.
     *
     * `write[0] ?? read[0]` took the first declared path whatever it was, so a
     * perfectly ordinary policy — `fs: { read: ["./package.json"] }` — produced
     * `--chdir` onto a file and every boot died with "Can't chdir: Not a
     * directory". A policy naming only files is not exotic, and the failure
     * gave no hint that the workdir was the problem.
     *
     * A file's own directory is NOT substituted: it may not be mounted, and
     * chdir'ing somewhere the policy did not grant is exactly the widening this
     * seam exists to prevent. `/` is always present inside the box and grants
     * nothing — an empty root holding only what was declared.
     */
    const workdir = fsDeclared ? (firstDirectory(write) ?? firstDirectory(read) ?? "/") : opts.cwd

    return {
        tier: opts.tier,
        user: opts.user ?? null,
        uid: opts.uid ?? null,
        gid: opts.gid ?? null,
        workdir,
        bindCwd: !fsDeclared,
        cwd: opts.cwd,
        entrypoint: opts.entrypoint,
        runtime: opts.runtime,
        fs: { read, write },
        control: opts.control ?? [],
        network: opts.network ?? null,
        hosts: opts.hosts ?? null,
        env: opts.env ?? {},
        limits: {
            memory: policy.limits?.memory ?? null,
            cpu: policy.limits?.cpu ?? null,
            pids: policy.limits?.pids ?? null,
            wall: policy.limits?.wall ?? null,
            disk: policy.limits?.disk ?? null,
        },
    }
}
