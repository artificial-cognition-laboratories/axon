import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { err } from "@axon/err"
import type { CapsulePolicy } from "../../types"
import { Bwrap } from "./bwrap"
import { Cgroup } from "./cgroup"
import { CONFINE_USER, ENTRYPOINT, probe, tierReady } from "./probe"
import { fromPolicy } from "./spec"

/**
 * Confinement — the OS box orchestrator. Linux only. Wiring only: it composes
 * the confinement leaves (Bwrap, Cgroup) and, on build(), produces the spawn
 * command the capsule execs and the teardown the build's undo stack runs.
 *
 * The tier is the caller's (Build reads policy.isolation). "auto" is rootless —
 * namespaces as the invoking user, user cgroups, no privilege, no uid drop.
 * "hardened" adds the dedicated-user drop and system cgroups and needs the host
 * provisioned via `axon install`.
 *
 * Construction does no OS work. build() is the effectful step: it probes the
 * requested tier (fail loud, never degrade), resolves the drop uid/gid for
 * hardened, and nests the wrappers:
 *
 *     systemd-run [--user] --scope <limits> -- bwrap <box> -- bun run <entrypoint>
 *
 * cgroup(outermost) owns the process tree so limits cover children; bwrap holds
 * the fs/pid/net isolation. Network is on/off inside bwrap for now; per-host
 * allowlisting needs a privileged netns helper and is a deliberate follow-up.
 *
 * Returns the { spawnCommand, cleanup } shape Build's atomic undo stack absorbs
 * unchanged. The systemd scope self-collects (`--collect`) when the tree dies,
 * covering shutdown, reload, and hard crashes — so cleanup() currently has
 * nothing to unwind. It stays on the handle because the privileged netns
 * follow-up will give it real teardown.
 */

type ConfinementOpts = {
    tier: "auto" | "hardened"
    cwd: string
    policy: CapsulePolicy
}

export type ConfinementHandle = {
    spawnCommand: { command: string; args: string[] }
    cleanup(): Promise<void>
}

export function Confinement(opts: ConfinementOpts) {
    const { tier, cwd, policy } = opts

    return {
        async build(): Promise<ConfinementHandle> {
            const status = probe(CONFINE_USER)
            if (!tierReady(tier, status)) throw err("CAPSULE_CONFINE_UNAVAILABLE", { context: { tier, ...status } })

            // Only the hardened tier drops to a dedicated user; auto runs rootless.
            let ids: { uid: number; gid: number } | null = null
            if (tier === "hardened") {
                ids = resolveIds(CONFINE_USER)
                if (!ids) throw err("CAPSULE_CONFINE_USER_UNRESOLVED", { context: { user: CONFINE_USER } })
            }

            const bun = resolveBun()
            const runtimeMounts = runtimePaths(bun, ENTRYPOINT)

            const spec = fromPolicy({
                policy,
                tier,
                cwd,
                entrypoint: ENTRYPOINT,
                runtime: runtimeMounts,
                user: tier === "hardened" ? CONFINE_USER : null,
                uid: ids?.uid ?? null,
                gid: ids?.gid ?? null,
            })

            const bwrap = Bwrap(spec)
            const cgroup = Cgroup(spec)

            // systemd-run(outermost) → bwrap → runtime. bun is referenced by its
            // absolute path so the box needs no PATH to find it.
            const runtime = [bun, "run", ENTRYPOINT]
            const full = cgroup.wrap(bwrap.wrap(runtime))

            return {
                spawnCommand: { command: full[0]!, args: full.slice(1) },
                // No stateful OS resource yet — the systemd scope self-collects.
                cleanup: async () => {},
            }
        },
    }
}

export type ConfinementT = ReturnType<typeof Confinement>

// ─── Mechanics ────────────────────────────────────────────────────────────────

/** Absolute path to the bun interpreter — the box references it by full path. */
function resolveBun(): string {
    const out = spawnSync("which", ["bun"], { encoding: "utf8" })
    const path = out.status === 0 ? out.stdout.trim() : ""
    // Fall back to the running interpreter if `which` is unavailable in this env.
    return path || process.execPath
}

/**
 * The read-only paths the box needs to run the subprocess — and NOTHING more.
 *
 * The subprocess is dependency-free at runtime by design: it imports only its
 * own relative source and node: builtins (type-only imports of @arcforge/types
 * are erased, so they need nothing mounted). Axon code — including @axon/err —
 * lives in the MANAGER, host-side; it never enters the box. So the box needs
 * exactly two things: the interpreter, and the subprocess's own source package.
 *
 * We mount the entrypoint's package directory (nearest ancestor with a
 * package.json). That is the capsule package — its own machinery, read-only,
 * carrying no user data and no workspace-symlinked dependencies. We deliberately
 * do NOT walk up to a workspace/monorepo root: that would drag in sibling
 * packages and, worse, a data-bearing ancestor (a bun.lock in $HOME once mounted
 * the entire home directory, re-exposing everything the fs policy blocked).
 */
function runtimePaths(bun: string, entrypoint: string): string[] {
    const paths = new Set<string>([bun])

    let dir = dirname(entrypoint)
    let pkg = dir
    while (true) {
        if (existsSync(join(dir, "package.json"))) {
            pkg = dir
            break
        }
        const parent = dirname(dir)
        if (parent === dir) break
        dir = parent
    }

    paths.add(pkg)
    return [...paths]
}

/** Resolve a username to numeric uid/gid via `id`. null if either is unreadable. */
function resolveIds(user: string): { uid: number; gid: number } | null {
    const uid = readId(["-u", user])
    const gid = readId(["-g", user])
    if (uid === null || gid === null) return null
    return { uid, gid }
}

function readId(args: string[]): number | null {
    const out = spawnSync("id", args, { encoding: "utf8" })
    if (out.status !== 0) return null
    const n = Number.parseInt(out.stdout.trim(), 10)
    return Number.isInteger(n) ? n : null
}
