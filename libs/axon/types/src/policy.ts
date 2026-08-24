// ─── Policy Rule ──────────────────────────────────────────────────────────────

/**
 * Low-level capsule rule for a single capability.
 *
 * - `true` always allows the operation.
 * - `false` always denies the operation.
 * - `"escalate"` pauses and asks the outer system for approval.
 * - An object applies glob-based `allow`, `deny`, and `escalate` matching to the
 *   first string argument, such as a path, host, or command.
 *
 * @see https://axon.arclabs.it/docs/v2/api/config/policy
 */
export type PolicyRule =
    | boolean
    | "escalate"
    | {
        allow?: string[]
        deny?: string[]
        escalate?: string[]
    }


/**
 * Capsule-level wire type. Describes what the sandbox subprocess is allowed to
 * do. Passed directly to the capsule on boot or via `capsule.update()`.
 *
 * Two enforcement surfaces, one policy:
 *
 *   - The MEDIATOR (all platforms) gates declared tool calls and
 *     process.run/process.spawn by glob — the soft layer: typed denials,
 *     escalation, span events. It owns `tools` and `process.{run,spawn}`.
 *   - OS CONFINEMENT (Linux) is the wall: `fs` becomes mount-namespace bind
 *     mounts, `network` becomes a net-namespace + nft allowlist, `limits`
 *     becomes cgroup caps. Where the two overlap (network), the OS layer is
 *     the truth and the mediator is only the polite error in front of it.
 *
 * `isolation` decides whether the OS wall exists at all.
 */
export type CapsulePolicy = {
    /**
     * OS confinement tier. Linux only; a no-op elsewhere (mediator still runs).
     *
     * The tiers map to what the occupant is and who's running it:
     *
     * - `"none"` — no OS wall. The subprocess runs as the invoking user with
     *   mediator enforcement only. This is what "I didn't set a security policy"
     *   means: a personal agent with full access to your machine, zero hassle,
     *   zero host dependencies. The default when no fs/network/limits is set.
     *
     * - `"auto"` — rootless containment. A bubblewrap box gives the subprocess
     *   (and every child) its own filesystem view (only declared paths exist),
     *   pid namespace, network on/off, and cgroup resource caps via
     *   `systemd-run --user`. Runs as the invoking user — isolation is by
     *   namespace, not by a second uid — so it needs NO privilege, NO password,
     *   NO `axon install`. This is the "don't read my keys / only this folder"
     *   tier: light security that just works. The default when any
     *   fs/network/limits policy is set.
     *
     * - `"hardened"` — privileged containment. Everything in `"auto"` plus a
     *   dedicated unprivileged OS user (true uid separation), system cgroups,
     *   and kernel network allowlisting. This is the org / VPS / untrusted-agent
     *   tier. Requires `axon install` (one-time root setup) and a privileged
     *   helper at runtime; a missing primitive is a hard boot error, never a
     *   silent downgrade. Explicit opt-in only — never defaulted into.
     */
    isolation?: "none" | "auto" | "hardened"

    /**
     * Filesystem view, enforced by the mount namespace under `isolation: "auto"`.
     * Paths outside these grants do not exist inside the box — a forbidden read
     * fails as "no such file", not "permission denied". The capsule cwd and the
     * runtime are always mounted; these extend that. Ignored under `"none"`.
     */
    fs?: {
        /** Extra paths mounted read-only. */
        read?: string[]
        /** Paths mounted read-write. */
        write?: string[]
    }

    /**
     * Network destinations, keyed by glob. Under `isolation: "auto"` this is
     * enforced in the kernel: the box has its own net namespace and an nft
     * allowlist, so only matching `host:port` destinations are reachable — a
     * raw socket cannot bypass it. The mediator mirrors these rules for typed
     * denials/escalation. Absent = no network at all.
     */
    network?: Record<string, PolicyRule>

    process: {
        spawn: PolicyRule
        run: PolicyRule
    }

    /**
     * OS resource caps, enforced as a systemd cgroup scope under
     * `isolation: "auto"`. Limits apply to the whole process tree, so children
     * cannot multiply the budget by spawning helpers. Ignored under `"none"`.
     */
    limits?: {
        /** Hard memory cap (systemd size, e.g. "2G"). OOM-killed on breach. */
        memory?: string
        /** CPU quota as a percent of one core (e.g. "50%" or "200%" for 2 cores). */
        cpu?: string
        /** Max processes/threads in the tree (fork-bomb cap). */
        pids?: number
    }

    tools?: Record<string, PolicyRule>
}


/** Command sent back to the capsule to allow or deny a pending escalation. */
export type PolicyResponseCommand = {
    id: string
    type: "policy:response"
    allow: boolean
}

export type PolicyCall = {
    /** Fully qualified function being evaluated, for example `"fs.write"` or `"proc.spawn"`. */
    fn: string
    /** Original arguments passed to the operation. */
    args: unknown[]
}

/** A pending escalation surfaced to the host's escalate callback. */
export type EscalationCall = {
    /** Escalation id — the policy:response answering this must echo it. */
    id: string
    /** Fully qualified function, e.g. "fs.write". */
    fn: string
    args: unknown[]
    /** The policy rule that triggered escalation. */
    rule: string
}