import type { ConfinementSpec } from "./spec"

/**
 * Cgroup — turn resource limits into a `systemd-run --scope` prefix. Pure:
 * spec in, argv out. systemd owns cgroup v2 creation, delegation, and teardown
 * (crash included), so we never touch /sys/fs/cgroup by hand.
 *
 * Tier decides scope ownership:
 *   - "auto"     — `--user` scope: the limit lands in the invoking user's own
 *                  systemd session. No root, no polkit prompt.
 *   - "hardened" — system scope: stronger (survives session, owned by the
 *                  system manager) but privileged.
 *
 * Limits apply to the transient scope, which contains the whole process tree —
 * children spawned inside the box share the budget and cannot multiply it. A
 * limit left null is not passed: unlimited for that dimension.
 */
export function Cgroup(spec: Pick<ConfinementSpec, "tier" | "limits">) {
    const { tier, limits } = spec

    function args(): string[] {
        const a = ["systemd-run"]
        if (tier === "auto") a.push("--user")
        a.push("--scope", "--quiet", "--collect")
        if (limits.memory !== null) a.push("-p", `MemoryMax=${limits.memory}`)
        if (limits.cpu !== null) a.push("-p", `CPUQuota=${limits.cpu}`)
        if (limits.pids !== null) a.push("-p", `TasksMax=${limits.pids}`)
        return a
    }

    return {
        args,
        /** `systemd-run [--user] --scope <limits> -- <inner...>`. */
        wrap(inner: string[]): string[] {
            return [...args(), ...inner]
        },
    }
}

export type CgroupT = ReturnType<typeof Cgroup>
