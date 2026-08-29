import { err } from "@arcforge/err"
import { writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { AxonBlueprint, CapsulePolicy } from "@arcforge/types"
import { Confinement, entrypoint as resolveEntrypoint, probe, tierReady } from "./confine"
import { resolveEnv } from "./confine/env"
import { boxedPid } from "./confine/netns"
import type { NetworkSpec } from "./confine/spec"
import { prepare, type SpawnedAgent } from "./spawn"
import type { SupervisorServices } from "./supervisor"
import { AGENT_BLUEPRINT_ENV } from "./entry"

/**
 * Spawning one agent INSIDE its box.
 *
 * Composes the two halves that were built separately: `prepare()` (sockets and
 * the link) and `Confinement()` (the OS wall). What this file owns is the
 * ordering and the mounts — everything a confined agent needs to exist that
 * neither half knows about on its own.
 */

type ConfinedOpts = {
    sessionId: string
    blueprint: AxonBlueprint
    /** The resolved policy — the same one the mediator enforces inside. */
    policy: CapsulePolicy
    services: SupervisorServices
    /** Absolute path to the agent entrypoint (`agent-main.ts` or its bundled form). */
    entrypoint: string
    onError(error: Error): void
}

/**
 * How long a connected agent is watched before it is declared up.
 *
 * The gap between "the socket came up" and "the runtime booted". Long enough
 * for a synchronous boot failure to be reported and land, short enough not to
 * be felt — a real boot is far slower than this and the wait ends the moment
 * the failure arrives.
 */
const BOOT_GRACE_MS = 250

export type ConfinedAgent = SpawnedAgent & {
    /** The child process. Killed by dispose(). */
    process: ReturnType<typeof Bun.spawn>
    /** Which tier actually built the box — reported, never assumed. */
    tier: "none" | "auto" | "container" | "hardened"
}

/**
 * Boot a confined agent and wait for it to connect.
 *
 * FAILS LOUD on a tier it cannot build. A runtime that quietly fell back to a
 * weaker tier when namespaces were unavailable would turn a misconfigured host
 * into a silent downgrade — which is the whole reason `container` is declared
 * rather than inferred.
 */
export async function spawnConfined(opts: ConfinedOpts): Promise<ConfinedAgent> {
    const tier = opts.policy.isolation ?? "none"

    // Arm the listeners BEFORE the child exists: a child that dials before
    // anyone is listening gets ECONNREFUSED and dies at startup.
    const link = prepare({
        sessionId: opts.sessionId,
        services: {
            ...opts.services,
            commit(type, data) {
                // The agent's own boot diagnosis, on its way to the log. Also
                // fails the spawn — a caller awaiting a runtime that will
                // never exist should get the reason, not a timeout.
                if (type === "axon:boot:failed") {
                    const reported = (data as { error?: { message?: string } })?.error
                    bootFailure.reject(err("AGENT_BOOT_FAILED", {
                        detail: reported?.message ?? "the agent failed to boot",
                        context: { sessionId: opts.sessionId },
                    }))
                }
                opts.services.commit(type, data)
            },
        },
        onError: opts.onError,
    })

    /**
     * The blueprint travels as a FILE, not an env var.
     *
     * It carries every tool's bundled source, so a real one runs to hundreds
     * of kilobytes — and `systemd-run` inlines the environment into its own
     * argv, so passing it inline blew past MAX_ARG_STRLEN (128KB on Linux,
     * regardless of the much larger ARG_MAX) and every spawn died with E2BIG.
     *
     * Written into the socket directory because that is already bind-mounted
     * into the box for the link: no second mount, no new hole, and it is
     * removed with the sockets on dispose.
     */
    const blueprintPath = join(link.root, "blueprint.json")
    writeFileSync(blueprintPath, JSON.stringify(opts.blueprint), { mode: 0o600 })

    /**
     * What the agent receives — built from nothing, never inherited.
     *
     * `resolveEnv` composes the agent's own `.env` with whatever
     * `policy.env.allow` grants from the host; the link's plumbing and the
     * blueprint path are the runtime floor and are added on top. Nothing else
     * crosses. See confine/env.ts for why the previous `{ ...process.env }`
     * was the single widest hole in the policy layer.
     */
    const resolved = resolveEnv({
        agentEnv: opts.blueprint.env ?? {},
        policy: opts.policy.env,
        host: process.env,
    })

    const env: Record<string, string> = {
        ...resolved.env,
        ...link.env,
        [AGENT_BLUEPRINT_ENV]: blueprintPath,
    }

    // Only "auto" and "hardened" build a box. "none" is the explicit opt-out;
    // "container" means a wall exists but somebody else owns it (see
    // CapsulePolicy.isolation); non-Linux has no primitives. All three run the
    // agent as an ordinary child with mediator-only enforcement.
    const buildsBox = (tier === "auto" || tier === "hardened") && process.platform === "linux"

    let command = [process.execPath, "run", opts.entrypoint]
    let cleanup: (() => Promise<void>) | null = null
    let network: NetworkSpec | null = null
    let stack: ReturnType<typeof Bun.spawn> | null = null

    if (buildsBox) {
        const status = probe()

        // A `net` allowlist that cannot be enforced is a boot error, never a
        // downgrade to unfiltered egress. The whole reason this layer exists is
        // that a policy naming one host used to reach every host.
        if (opts.policy.net && !status.network) {
            link.connected.catch(() => {})
            throw err("CAPSULE_NET_UNAVAILABLE", {
                context: { nft: status.nft, slirp: status.slirp },
            })
        }

        if (!tierReady(tier, status)) {
            link.connected.catch(() => {})
            throw new Error(`CAPSULE_CONFINE_UNAVAILABLE: tier "${tier}" needs primitives this host lacks (${JSON.stringify(status)})`)
        }

        const confinement = await Confinement({
            tier,
            cwd: opts.blueprint.paths.root,
            policy: opts.policy,
            entrypoint: opts.entrypoint,
            // Everything the box may see. `--clearenv` means this is the whole
            // of it: omit a name here and it does not exist inside.
            env,
            // The socket directory, so the agent can dial its supervisor.
            control: [link.root],
            // The agent's own code: the project root holds the cognet bundle
            // under .agent/, the tool sources, and the node_modules the bundle
            // resolves against.
            project: [opts.blueprint.paths.root, dirname(opts.entrypoint)],
        }).build()

        command = [confinement.spawnCommand.command, ...confinement.spawnCommand.args]
        cleanup = confinement.cleanup
        network = confinement.network
    }

    const child = Bun.spawn(command, {
        /**
         * TWO ENVIRONMENTS, and conflating them breaks one or the other.
         *
         * What the AGENT receives is `env` — the agent's own `.env` plus what
         * `policy.env.allow` granted, and nothing else. Under confinement bwrap
         * enforces that with `--clearenv` and re-adds exactly that set, so what
         * is passed here never reaches the agent.
         *
         * But the command being spawned is not the agent: it is
         * `systemd-run → bwrap → …`, and those run on the HOST. `systemd-run
         * --user` talks to the user's session bus, so stripping the host
         * environment killed it with "Failed to connect to bus: No medium
         * found" — every confined agent with limits failed to boot, and the
         * error named dbus rather than anything a reader would connect to
         * policy.
         *
         * So the wrapper chain gets the host environment it needs, and the
         * BOX's environment is set by bwrap. When no box is built the resolved
         * env is all the agent gets, which is what keeps the unconfined path
         * honest — an `isolation: "none"` agent must not inherit the shell
         * either.
         */
        env: buildsBox ? { ...process.env, ...wrapperEnv(), ...env } : env,
        /**
         * The agent runs in ITS OWN root, never the caller's directory.
         *
         * Its code should behave the same wherever it was invoked from, and
         * identically to how it runs deployed — where there is no invocation
         * directory at all. Inheriting the CLI's cwd made a script's
         * `fs.read("axon.config.ts")` depend on where the user happened to be
         * standing: it worked from inside the agent and failed one directory
         * up, which is the same script giving two answers.
         *
         * Set HERE rather than only on the confinement above: that path
         * configures the bwrap box, which an `isolation: "none"` agent never
         * builds — so an unboxed agent silently inherited the caller's cwd
         * while a boxed one did not.
         *
         * The invocation directory is not lost: it reaches the agent through
         * the blueprint as the platform's own `cwd`, for the things that
         * genuinely mean "where the user is".
         */
        cwd: opts.blueprint.paths.root,
        stdout: "pipe",
        stderr: "pipe",
    })

    /**
     * The box's network stack, attached once the child exists.
     *
     * `slirp4netns` needs a PID to join, so this cannot happen inside
     * `Confinement.build()` — the process does not exist until the spawn above.
     * It furnishes the box's namespace with a tap device and a route; the
     * launcher inside the box waits for that device before installing the nft
     * ruleset and exec'ing the agent.
     *
     * Runs as an ordinary child of the supervisor with no privilege. It dies
     * with the agent (nothing else holds the namespace open) and is killed
     * explicitly on dispose so a crashed agent cannot leave one behind.
     */
    if (network) {
        /**
         * The pid slirp joins is the one INSIDE the box, not the one we
         * spawned. See boxedPid() — every wrapper in the
         * `systemd-run → bwrap → launcher` chain stays in the host's
         * namespaces, and handing slirp the outer pid fails as
         * "setns(CLONE_NEWNET): Operation not permitted".
         */
        const inner = await boxedPid(child.pid)
        if (inner === null) {
            child.kill()
            link.connected.catch(() => {})
            throw err("CAPSULE_NET_UNAVAILABLE", {
                detail: "the box's network namespace never appeared, so egress filtering could not be attached",
                context: { pid: child.pid },
            })
        }

        stack = Bun.spawn([
            "slirp4netns",
            "--configure",
            "--mtu=65520",
            // The box must not be able to reach services on the HOST's loopback
            // — a filter on external egress that left localhost open would be
            // trivially bypassed by anything the user happens to be running.
            "--disable-host-loopback",
            String(inner),
            "tap0",
        ], { stdout: "ignore", stderr: "pipe" })
    }

    /**
     * The agent must never outlive its supervisor.
     *
     * Without this, closing the TUI left the agent running: `Bun.spawn` does
     * not kill children on exit, so every session leaked a process that was
     * then reparented to init and kept its cognet, its capsule and its
     * sockets alive forever. Six were found running after a few minutes of
     * ordinary use.
     *
     * A synchronous `exit` handler is the only reliable cross-platform hook —
     * the same guarantee the capsule's own Spawn() has always had. It covers
     * a clean exit and an unhandled throw; it cannot cover SIGKILL, which is
     * what `--die-with-parent` in the bwrap box handles for the confined tier
     * and what the agent's own link-close watch handles for the unconfined
     * one (see agent-main).
     */
    const killOnExit = () => {
        try { child.kill() } catch { /* already gone is the outcome we wanted */ }
    }
    process.on("exit", killOnExit)

    /**
     * The agent's last words, captured while it boots.
     *
     * Nothing else reads this stream, and a boot failure is exactly when it
     * matters: the agent throws a fully-formed error, dies, and the supervisor
     * sees only a closed socket. Reported as LINK_PEER_CLOSED, that told a user
     * their agent disconnected while the actual cause — a missing cognet, a
     * tool that would not compile — was sitting unread in a pipe.
     */
    /**
     * A boot failure the agent reported through the link, as a promise the
     * spawn race can lose to. Never resolves in the normal case.
     */
    const bootFailure = (() => {
        let reject!: (error: Error) => void
        const promise = new Promise<never>((_r, rj) => { reject = rj })
        // Nothing awaits this until the race below, and an unobserved
        // rejection would be fatal in the meantime.
        promise.catch(() => {})
        return { promise, reject }
    })()

    const stderr: string[] = []
    void (async () => {
        for await (const chunk of child.stderr as ReadableStream<Uint8Array>) {
            stderr.push(new TextDecoder().decode(chunk))
        }
    })().catch(() => { /* the pipe closing with the process is not itself a fault */ })

    /**
     * The agent's stdout, forwarded to ours.
     *
     * Piped rather than inherited so the supervisor decides where it goes,
     * but it MUST be drained: an unread pipe is discarded output today and a
     * blocked agent once the buffer fills. It was unread — a script's
     * `console.log` reached the agent's real console (its ALS capture does
     * not survive the dynamic import that runs a script), went into this
     * pipe, and vanished.
     *
     * Forwarded live rather than accumulated like stderr above: stderr is
     * held to diagnose a boot that never connects, while stdout is the
     * agent's own output to a person watching — buffering it until exit
     * would make a long-running script look silent.
     */
    void (async () => {
        for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
            process.stdout.write(chunk)
        }
    })().catch(() => { /* the pipe closing with the process is not itself a fault */ })

    /**
     * Whichever happens first: the agent connects, or it dies trying.
     *
     * Without the race this awaited a connection that was never coming — a
     * child that exits at startup leaves `connected` pending forever, so a
     * broken agent presented as a hang rather than an error. The exit branch
     * always throws; it exists to convert silence into a diagnosis.
     */
    /**
     * Whichever happens first: the agent is up, or it is dead.
     *
     * Three outcomes, and each needed its own arm because each presented as a
     * hang or a lie before:
     *
     *   connected  — the socket came up. NOT the same as booted: the agent
     *                connects before it constructs its runtime, precisely so a
     *                boot failure is reportable.
     *   exited     — the process died. Without this arm `connected` stayed
     *                pending forever and a broken agent looked like a hang.
     *   bootFailed — the agent reported a boot failure through the link and
     *                then died. Its own diagnosis, which is far better than
     *                the closed socket the supervisor would otherwise see.
     *
     * `bootFailed` wins over `exited` when both fire, because the agent's own
     * error names the cause and the exit code only names the symptom.
     */
    /**
     * A boot that FAILS must clean up after itself.
     *
     * `cleanup` used to run only from `dispose()`, which a failed boot never
     * reaches — so every unsuccessful spawn permanently leaked its netup
     * directory (the launcher, the ruleset, the hosts file). Measured: ~100
     * stale `/tmp/axon-net-*` directories after a few test runs. On a machine
     * booting agents all day that is unbounded growth in /tmp, and the files
     * left behind describe the agent's network policy.
     *
     * The stack is torn down too: slirp holds the box's namespace open, and an
     * agent that died at boot must not leave one running.
     */
    const spawned = await Promise.race([
        // Connected is NOT booted: the agent dials before it constructs its
        // runtime, so this arm resolves while the boot may still be in flight.
        // Waiting a beat lets a boot failure — which the agent reports through
        // the link a moment later — win the race instead of losing to a socket
        // that came up fine.
        link.connected.then(async agent => {
            await Promise.race([
                bootFailure.promise,
                new Promise(resolve => setTimeout(resolve, BOOT_GRACE_MS)),
            ])
            return agent
        }),
        bootFailure.promise,
        child.exited.then(async code => {
            // The agent may have reported a reason a moment before dying.
            // Give that commit a turn to land rather than racing past it.
            await Promise.race([bootFailure.promise, new Promise(r => setTimeout(r, 150))])
            throw err("AGENT_BOOT_FAILED", {
                detail: stderr.join("").trim() || `the agent process exited with code ${code} before connecting`,
                context: { code, tier },
            })
        }),
    ]).catch(async error => {
        process.removeListener("exit", killOnExit)
        stack?.kill()
        child.kill()
        await cleanup?.()
        throw error
    })

    return {
        ...spawned,
        process: child,
        tier: buildsBox ? tier : (tier === "container" ? "container" : "none"),
        dispose() {
            process.removeListener("exit", killOnExit)
            stack?.kill()
            child.kill()
            spawned.dispose()
            void cleanup?.()
        },
    }
}

/**
 * The host variables the WRAPPER CHAIN needs — never the agent's.
 *
 * `systemd-run --user` creates a transient scope through the user's systemd
 * instance, which it reaches over the session bus. Without these it cannot find
 * the bus at all. They are named explicitly rather than inherited wholesale so
 * that what the wrappers need stays legible and does not quietly grow.
 *
 * None of this reaches the agent: bwrap sits inside the chain and clears the
 * environment before exec'ing it.
 */
function wrapperEnv(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const key of ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "PATH", "HOME", "USER"]) {
        const value = process.env[key]
        if (value !== undefined) out[key] = value
    }
    return out
}

/**
 * Where the agent entrypoint may live, relative to whoever OWNS it.
 *
 * The published CLI ships it bundled beside the app; in the workspace it is
 * the TypeScript source. Checked in that order for the same reason the
 * capsule's own resolution was: getting it wrong is total — the box execs a
 * path that does not exist and every boot fails with "Module not found".
 *
 * The DIRECTORY is a parameter rather than `import.meta.dir`, because the
 * entrypoint no longer lives beside this file. `agent-main.ts` runs inside the
 * box and reaches the cloud, the session log and the blueprint scanners — none
 * of which belong in a transport package — so it stayed with the platform when
 * the wire moved out. Resolving from here would name a path in this package
 * that nothing ever writes.
 */
export function agentEntrypoints(dir: string): string[] {
    return [join(dir, "agent-main.js"), join(dir, "agent-main.ts")]
}

/** Resolve the agent entrypoint from the candidates a build may have produced. */
export function agentEntrypoint(candidates: string[]): string {
    return resolveEntrypoint(candidates)
}
