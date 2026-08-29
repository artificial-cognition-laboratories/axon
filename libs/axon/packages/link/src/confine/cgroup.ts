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
        /**
         * MemoryMax ALONE IS NOT A MEMORY CAP.
         *
         * cgroup v2 accounts memory and swap separately, and `MemoryMax` bounds
         * only the former. On any host with swap enabled — which is most — a
         * process that breaches it is not killed: it spills into swap and keeps
         * running. Measured here: `MemoryMax=64M` allocated 300MB anonymous and
         * exited 0, while the same run with the swap bound exited 137.
         *
         * So the two are set TOGETHER, always. A user writing
         * `limits: { memory: "2G" }` means "this agent gets 2G", not "2G of RAM
         * plus unbounded swap" — and the second reading is the one that lets a
         * runaway agent consume the machine while its cap reads as enforced.
         */
        if (limits.memory !== null) {
            a.push("-p", `MemoryMax=${limits.memory}`)
            a.push("-p", "MemorySwapMax=0")
        }
        if (limits.cpu !== null) a.push("-p", `CPUQuota=${limits.cpu}`)
        if (limits.pids !== null) a.push("-p", `TasksMax=${limits.pids}`)

        /**
         * Wall-clock ceiling, as systemd's own runtime cap.
         *
         * `RuntimeMaxSec` on the scope rather than a timer in the supervisor:
         * systemd kills the whole cgroup, so it covers a tree that has escaped
         * its parent, and it survives a supervisor that has itself hung — which
         * is precisely the case a supervisor-side timer cannot cover.
         */
        if (limits.wall !== null) a.push("-p", `RuntimeMaxSec=${limits.wall}`)
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
