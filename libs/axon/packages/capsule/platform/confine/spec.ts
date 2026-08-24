import { isAbsolute, resolve } from "node:path"
import type { CapsulePolicy } from "../../types"

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

    /** Network destinations (host:port globs). Empty = no network at all. */
    network: string[]

    limits: {
        /** Hard memory cap as a systemd size string, or null for unlimited. */
        memory: string | null
        /** CPU quota (systemd CPUQuota form, e.g. "50%"), or null. */
        cpu: string | null
        /** Max processes/threads in the tree, or null. */
        pids: number | null
    }
}

type FromPolicyOpts = {
    policy: CapsulePolicy
    tier: "auto" | "hardened"
    cwd: string
    entrypoint: string
    runtime: string[]
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
    const workdir = fsDeclared ? (write[0] ?? read[0]!) : opts.cwd

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
        network: Object.keys(policy.network ?? {}),
        limits: {
            memory: policy.limits?.memory ?? null,
            cpu: policy.limits?.cpu ?? null,
            pids: policy.limits?.pids ?? null,
        },
    }
}
