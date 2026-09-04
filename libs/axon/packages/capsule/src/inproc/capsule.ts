import { randomUUID } from "node:crypto"
import { err } from "@arcforge/err"
import type { CapsuleBlueprint, CapsuleTool } from "../../types"
import type { CapsuleBusT } from "../../platform/bus"
import { Activities } from "../process/activities"
import { Console } from "../process/console"
import { Execution } from "../process/execution"
import { Mediator } from "../process/mediator"
import { SandboxProcs } from "../process/procs"
import { Escalation } from "../sandbox/escalation"
import { Runner } from "../process/runner"
import { join } from "node:path"
import { Scope } from "../process/scope"
import { installScope } from "../scope/scope"
import { InProcWire } from "./emitter"

/**
 * InProcSandbox — everything the capsule subprocess was, in this heap.
 *
 * The mirror of `process/sandbox.ts`, wiring the SAME leaves: mediator, scope,
 * procs, runner, console, activities. What changes is only what sits under
 * them — `InProcWire` instead of stdio JSONL, and direct calls instead of a
 * command channel.
 *
 * That is the whole point of the port. None of the machinery below was about
 * the boundary: the runner transpiles and evals, the scope loads tools and
 * wraps them for mediation, procs shells out. They ran in a subprocess because
 * the subprocess WAS the isolation. Now the agent process is, so they run here
 * and the wire between them disappears.
 *
 * ── What is genuinely lost, and it is worth naming ──────────────────────────
 *
 * Hard cancellation. The subprocess could be killed mid-eval; a tight
 * synchronous loop in model-emitted code could always be stopped by ending the
 * process it ran in. In one heap there is no second process to do that, so
 * `interrupt` stays COOPERATIVE — mediated calls observe the signal and
 * return, which covers every await-shaped operation the model actually writes.
 *
 * A genuine `while(true)` now hangs the agent rather than the capsule. The
 * supervisor still kills and restarts it, so the blast radius is one agent and
 * one conversation; what is gone is recovering without that restart.
 */
type InProcOpts = {
    config: CapsuleBlueprint
    bus: CapsuleBusT
}

export function InProcSandbox(opts: InProcOpts) {
    /**
     * The cwd this sandbox was configured with, restored on shutdown.
     *
     * `process.chdir()` from model code moves the WHOLE process now — there is
     * no subprocess whose exit undid it. A sandbox that shut down while parked
     * in a directory someone then deleted left the process with an unlinked
     * cwd, and everything that resolves a relative path afterwards fails:
     * `new Bun.Transpiler()` throws CurrentWorkingDirectoryUnlinked, so the
     * NEXT agent in this process cannot even compile a submission.
     *
     * Restoring is the honest boundary: a sandbox may move the process while
     * it is running, and must hand it back where it found it.
     */
    const hostCwd = process.cwd()
    /** Env values this capsule overwrote, for restoration on shutdown. */
    const priorEnv = new Map<string, string | undefined>()
    const configuredCwd = opts.config.cwd || hostCwd

    const wire = InProcWire(opts.bus)
    const sandboxConsole = Console({ wire })
    // Constructed before its consumers: mediator/scope/activities correlate
    // their emissions to the running command through this one store.
    const execution = Execution()
    const mediator = Mediator({ policy: opts.config.policy, wire, execution })
    // The agent's own scratch, from the config. Falling back to the cwd's
    // frame keeps a programmatic caller that never set one working, and both
    // are the agent's own tree rather than the host's temp directory.
    const scratch = opts.config.scratch ?? join(configuredCwd, ".agent", "cache", "tools")
    const scope = Scope({ dispatch: false, mediator, wire, execution, scratch })
    const procs = SandboxProcs({ mediator, wire })
    const activities = Activities({ wire, execution })
    const runner = Runner({ dispatch: false, scope, wire, console: sandboxConsole, execution, activities })

    /**
     * Escalation, in one heap.
     *
     * The mediator emits `policy:escalation` and waits for a
     * `policy:response` command to come back. Across the wire that round trip
     * went host → decider → guest; here it is the same round trip with
     * `wire.deliver()` standing in for the send, so the mediator's own
     * pending-map and timeout are untouched.
     *
     * The DECIDER stays outside: a program able to reach it could raise and
     * answer its own escalations, which is exactly as true in one process as
     * in two.
     */
    Escalation({
        send: command => wire.deliver(command),
        bus: opts.bus,
        ...(opts.config.escalate ? { decide: opts.config.escalate } : {}),
    })

    /**
     * The `process.run`/`process.spawn` globals, installed ONCE per process.
     *
     * `installScope` refuses a second call — it is a global mutation and two
     * agents in one heap would fight over `process.run`. That guard was
     * harmless when every capsule owned its own process; here it means an
     * embedder booting two runtimes in one process gets a loud failure rather
     * than one agent silently shelling out through the other's mediator.
     */
    function install(): void {
        installScope({
            // This sandbox is the current owner of the process verbs. A
            // reload builds a new one against a new policy, and the globals
            // must follow it — otherwise model code keeps shelling out
            // through the mediator the user just replaced.
            rebind: true,
            run: (command, runOpts) => procs.run(command, runOpts, execution.current?.signal),
            spawn: (command, spawnOpts) => procs.spawn(command, spawnOpts),
            // The model's own view of what it has running. Without these its
            // only settled signal was `exited`, so a background process could
            // be observed only by waiting for it to die.
            procs: () => procs.list(),
            proc: procId => procs.get(procId),
            write: (level, data) => sandboxConsole.write(level, data),
            // Only capture while a command is running — the host shares this
            // process's stdout and must not be silenced by an agent's
            // existence. See installScope.
            capture: () => execution.current !== null,
            axon: {
                activity: activities.activity,

                /**
                 * `axon.request()` from tool code — a DIRECT call now.
                 *
                 * Across the wire this was a correlated round trip: emit a
                 * host:request, match the response by id, propagate the
                 * command's abort. The host is a plain callable on the
                 * config, so in one heap the whole correlation layer collapses
                 * into calling it.
                 *
                 * What is preserved is the signal: the call still carries the
                 * running command's AbortSignal, so an interrupt reaches
                 * whatever the host is doing on the agent's behalf rather than
                 * leaving it running past the run that asked for it.
                 */
                request(input) {
                    const host = opts.config.host
                    if (!host) {
                        return Promise.reject(err("CAPSULE_HOST_UNAVAILABLE", {
                            detail: "axon.request() needs a host service provider, and none is configured",
                        }))
                    }
                    const normalized = typeof input === "string" ? { prompt: input } : input
                    const signal = execution.current?.signal ?? new AbortController().signal
                    return host.call({ method: "request", input: normalized, signal }) as never
                },
            },
        })
    }

    return {
        /** Load the configured tools. Sequential, and a failure is an event as before. */
        async boot(tools: CapsuleTool[]): Promise<void> {
            // OPEN the boot span before doing any of the work it measures.
            //
            // The subprocess path emitted this when the child announced
            // itself; in one heap there is no announcement, and the open half
            // was simply lost while `process:boot:complete` survived. Every
            // consumer that pairs a span's ends then saw a close with no
            // start: the ontology suite counted the depth at -1, and Fleet's
            // flame graph had a bar it could not place or time.
            //
            // `durationMs` was hardcoded to 0 for the same reason — with no
            // start there was nothing to measure from. It is real now.
            const bootStarted = Date.now()
            wire.emit("process:boot:start", {})
            // Everything the span measures runs inside the try, so a boot that
            // THROWS still closes it. Tool loading and the scope handshake both
            // throw deliberately (a capsule missing scope the agent was
            // promised is invalid state, not a warning) — and an open span that
            // never closes is the same ontology break as a close with no open,
            // just harder to see: the depth stays positive forever and the
            // flame graph grows a bar with no end.
            //
            // Rethrown, never swallowed. `process:boot:failed` is the durable
            // record of what happened; the caller still has to fail.
            try {
                /**
                 * ENTER the configured directory.
                 *
                 * The subprocess was spawned with `cwd`, so it simply started
                 * there. Nothing does that in one heap — the process is wherever
                 * the host left it — so a capsule configured with a working
                 * directory ran in the host's instead, and every relative path
                 * model code wrote resolved against the wrong root.
                 *
                 * Moving the whole process is the honest cost of the merge, and
                 * it is why shutdown restores: while this capsule is alive, its
                 * cwd IS the process's.
                 */
                /**
                 * The configured env, applied to THIS process.
                 *
                 * `config.env` overlaid the spawned subprocess's environment. In
                 * one heap there is no spawn, so an agent's declared vars simply
                 * never existed — model code reading `process.env.MY_KEY` got
                 * undefined for something the config plainly set.
                 *
                 * Overlaid rather than replacing: the agent needs the ambient
                 * environment too (PATH, HOME, the provider vars the runtime
                 * resolved), and the config narrows or adds to it. Keys are
                 * restored on shutdown for the same reason cwd is — this process
                 * is shared, and what one capsule sets must not leak to the next.
                 */
                for (const [key, value] of Object.entries(opts.config.env ?? {})) {
                    priorEnv.set(key, process.env[key])
                    process.env[key] = value
                }

                if (process.cwd() !== configuredCwd) {
                    try { process.chdir(configuredCwd) } catch { /* gone — the run will fail on its own terms */ }
                }
                install()
                for (const tool of tools) {
                    /**
                     * Load, then VERIFY the tool is what it declared.
                     *
                     * The subprocess build did this across the wire: it sent a
                     * `tool:load`, waited for `tool:load:complete`, and compared
                     * the exports it reported against the members the scope
                     * declared — failing the boot on a mismatch, because a capsule
                     * missing scope the agent was promised is invalid state rather
                     * than a warning.
                     *
                     * That handshake went with the wire, and the check has to come
                     * with it: what the model is TOLD it can call must be what
                     * actually loaded, or the model calls a function that is not
                     * there and gets "not defined" at the worst possible moment.
                     */
                    let failure: unknown = null
                    const off = opts.bus.on("process:tool:load:failed", event => {
                        if (event.namespace === tool.namespace) failure = event.error
                    })
                    try {
                        await scope.load({
                            type: "tool:load",
                            namespace: tool.namespace,
                            ...("source" in tool ? { source: tool.source } : { path: tool.path }),
                        } as never)
                    } finally {
                        off()
                    }

                    if (failure) {
                        throw err("CAPSULE_TOOL_FAILED", {
                            detail: `"${tool.namespace}" — ${(failure as { message?: string }).message ?? "failed to load"}`,
                            context: { namespace: tool.namespace },
                        })
                    }

                    const declared = tool.scope.members.map(member => member.name).sort()
                    const loaded = Object.keys(scope.exportsOf(tool.namespace) ?? {}).sort()
                    if (declared.length !== loaded.length || declared.some((name, i) => name !== loaded[i])) {
                        throw err("CAPSULE_TOOL_SCOPE_MISMATCH", {
                            detail: `"${tool.namespace}" declares [${declared.join(", ")}] but exports [${loaded.join(", ")}]`,
                            context: { namespace: tool.namespace, declared, loaded },
                        })
                    }
                }
            
            } catch (cause) {
                wire.emit("process:boot:failed", { durationMs: Date.now() - bootStarted, error: err(cause).toJSON() })
                throw cause
            }
            wire.emit("process:boot:complete", { durationMs: Date.now() - bootStarted })
        },

        /** Execute one submission and settle when it completes. */
        run(code: string, runOpts?: { id?: string; origin?: "cognet" | "host" }): { id: string; done: Promise<void> } {
            const id = runOpts?.id ?? randomUUID()
            return { id, done: runner.run(id, code, runOpts?.origin) }
        },

        kill: runner.kill,
        scope,
        procs,

        /**
         * The block executing on this async path, or null outside one.
         *
         * Exposed because the KERNEL mediates tool calls (mediation.ts) while
         * the capsule owns the execution store that knows which block is
         * running. A tool call happens inside a capsule block, so the id is
         * right here — the kernel just had no way to read it, and stubbed
         * `commandId: ""` on every span it committed.
         *
         * Reading through the AsyncLocalStorage rather than a mutable field is
         * what makes this correct under concurrency: `runBatch` runs blocks
         * together, and a shared "current id" would attribute one block's
         * denial to whichever started last.
         */
        get commandId(): string | null {
            return execution.current?.id ?? null
        },

        /** Kill every managed child, and hand the process back where we found it. */
        shutdown(): void {
            procs.killAll()
            // Hand the environment back, same reason as cwd: shared process.
            for (const [key, prior] of priorEnv) {
                if (prior === undefined) delete process.env[key]
                else process.env[key] = prior
            }
            priorEnv.clear()
            // Model bindings are on the shared globalThis now — a capsule that
            // does not clean up leaves its variables for the next one.
            runner.dispose()
            try {
                // Back to where the HOST was, not where we were configured:
                // the host's directory is the one another capsule (or the
                // test runner) expects to find on its next call.
                //
                // A RELOAD IS THE EXCEPTION, and it is handled by the caller
                // rather than guessed at here: reload boots the new sandbox
                // BEFORE shutting the old one down (an overlap, not a gap —
                // see AxonCapsule.reload), so by the time this runs a
                // successor is already parked where it wants to be. This
                // sandbox cannot see that successor, so AxonCapsule re-applies
                // the directory after the outgoing shutdown instead.
                if (process.cwd() !== hostCwd) process.chdir(hostCwd)
            } catch {
                // The entry cwd is itself gone — nothing to restore to, and
                // failing here would mask whatever the caller was shutting
                // down for. The next boot resolves its own.
            }
        },
    }
}

export type InProcSandboxT = ReturnType<typeof InProcSandbox>
