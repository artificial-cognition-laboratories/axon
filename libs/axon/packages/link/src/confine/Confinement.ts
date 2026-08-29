import { spawnSync } from "node:child_process"
import { rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { err } from "@arcforge/err"
import type { CapsulePolicy } from "@arcforge/types"
import { Bwrap } from "./bwrap"
import { Cgroup } from "./cgroup"
import { CONFINE_USER, probe, tierReady } from "./probe"
import { resolveNetwork } from "./network"
import { netUp } from "./netup"
import { fromPolicy } from "./spec"
import type { NetworkSpec } from "./spec"

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
    /**
     * Absolute path to the program the box execs.
     *
     * Supplied by the caller rather than resolved here: confinement knows how
     * to build a box, never what goes in it. That is what lets one builder
     * confine the capsule subprocess and, after the agent-process reshuffle,
     * the whole agent — without this module learning either name.
     */
    entrypoint: string
    /**
     * Supervisor plumbing that must exist inside the box — the link socket
     * directory. Not a user grant: kept separate from the fs policy so that
     * `axon policy` renders what the user allowed, not the runtime's wiring.
     */
    control?: string[]
    /**
     * The environment the box receives, beyond the runtime floor.
     *
     * Must carry the supervisor's plumbing — the link socket paths, the
     * blueprint path — because `--clearenv` discards everything else. Passing
     * these through `Bun.spawn`'s `env` alone is NOT enough: that sets the
     * environment bwrap starts with, and bwrap then clears it before exec'ing
     * the agent. The agent came up with `AXON_AGENT_LINK` undefined and died
     * parsing it, which is exactly the failure mode `--clearenv` should have.
     */
    env?: Record<string, string>
    /**
     * The AGENT'S OWN files — its project root, so the cognet bundle, the
     * tool sources and the node_modules it imports from all exist in the box.
     *
     * Distinct from `fs.read`, which is the user's policy over the wider
     * filesystem, and from `runtime`, which is the interpreter. This is the
     * agent itself: whatever `axon prepare` produced under `.agent/` plus the
     * dependencies the bundle resolves against. Read-only — an agent may run
     * its own code and must not rewrite it mid-run.
     *
     * Mounting it is what the reshuffle needs and the capsule deliberately
     * avoided: there, tool source was BUNDLED and materialised inside the box
     * precisely so no project file was ever mounted. In-process the agent's
     * own code is the program, so it has to be present — and naming it here
     * keeps "the agent's code" distinguishable from "what the user granted".
     */
    project?: string[]
}

export type ConfinementHandle = {
    spawnCommand: { command: string; args: string[] }
    /**
     * The resolved egress rules, or null when the box has no network stack.
     *
     * Returned because the SUPERVISOR has work to do with it: a filtered box
     * needs `slirp4netns` attached to its namespace once the child exists, and
     * that cannot happen from in here — the pid does not exist until the caller
     * spawns it.
     */
    network: NetworkSpec | null
    cleanup(): Promise<void>
}

export function Confinement(opts: ConfinementOpts) {
    const { tier, cwd, policy, entrypoint } = opts

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
            const runtimeMounts = runtimePaths(bun, entrypoint)

            /**
             * Egress resolution — the one effectful step in building the spec.
             *
             * Done HERE rather than in `fromPolicy` because it is a DNS lookup:
             * real I/O, which the narrowing seam must stay free of. Returns
             * null when the policy grants no network, which the box expresses
             * as a namespace with no stack rather than an empty allowlist.
             */
            const network = await resolveNetwork(policy.net)

            // An allowlist entry that resolved to nothing is a grant the user
            // believes they made and did not. Loud, because the alternative is
            // an agent that cannot reach a host its policy names and no reason
            // anywhere that says why.
            if (network && network.unresolved.length > 0) {
                throw err("CAPSULE_NET_UNRESOLVED", {
                    detail: `net policy names ${network.unresolved.join(", ")}, which did not resolve`,
                    context: { unresolved: network.unresolved },
                })
            }

            const net = network ? netUp(network, [bun, "run", entrypoint]) : null

            const spec = fromPolicy({
                policy,
                tier,
                cwd,
                network,
                hosts: net?.hosts ?? null,
                ...(opts.env ? { env: opts.env } : {}),
                entrypoint: entrypoint,
                ...(opts.control ? { control: opts.control } : {}),
                // The launcher and its ruleset are mounted read-only with the
                // rest of the runtime: the agent must be able to exec the
                // launcher and nft must be able to read the rules, but neither
                // may be rewritten from inside the box.
                runtime: [...runtimeMounts, ...(opts.project ?? []), ...(net ? [net.dir] : [])],
                user: tier === "hardened" ? CONFINE_USER : null,
                uid: ids?.uid ?? null,
                gid: ids?.gid ?? null,
            })

            const bwrap = Bwrap(spec)
            const cgroup = Cgroup(spec)

            /**
             * systemd-run(outermost) → bwrap → [launcher] → runtime.
             *
             * With a network policy the box execs the LAUNCHER, which installs
             * the nft ruleset inside the namespace and then `exec`s the runtime
             * — so no extra process survives and the filter is armed before any
             * agent code runs. Without one, bwrap execs the runtime directly.
             *
             * bun is referenced by absolute path either way, so the box needs
             * no PATH to find it.
             */
            const inner = net ? [net.script] : [bun, "run", entrypoint]
            const full = cgroup.wrap(bwrap.wrap(inner))

            return {
                spawnCommand: { command: full[0]!, args: full.slice(1) },
                network,
                cleanup: async () => {
                    if (net) await rm(net.dir, { recursive: true, force: true })
                },
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
