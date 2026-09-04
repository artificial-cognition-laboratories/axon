#!/usr/bin/env bun
import { err } from "@arcforge/err"
/**
 * The confined agent process — what the box execs.
 *
 * Replaces the capsule's `process/main.ts` as the program inside the wall. The
 * difference is what it contains: the capsule held only model-emitted code and
 * tools, with the cognet and the kernel outside it. This holds the WHOLE agent
 * — cognet, kernel, tools, scripts, routes, and model-emitted code — one heap,
 * one context, bounded by one OS box.
 *
 * What stays outside is what must never enter: the provider credential, the
 * session log, and the escalation decider. The agent asks for those over the
 * link and can never obtain, transfer, or outlive them.
 *
 * Boot order matters:
 *   1. read the link paths (a missing carrier means nobody supervises us)
 *   2. dial both channels BEFORE booting — the runtime commits during boot,
 *      and a commit with no link would be a lost audit record
 *   3. boot Axon() with `remote` set, which is what puts tools in this heap
 *      and inference on the wire
 *   4. serve the four verbs until told to stop
 */
import { readFileSync } from "node:fs"
import { Axon, AxonBus } from "@arcforge/core"
import { Routes, Middleware, Plugins } from "../build/blueprint"
import type { AxonCommitContext, AxonMiddleware, AxonPartialBlueprint, AxonPlugin, AxonRoute } from "@arcforge/types"
import {
    AGENT_BLUEPRINT_ENV,
    AgentRuntime,
    RemoteDriver,
    agentHandlers,
    connect,
    readLinkEnv,
    supervisorProxy,
} from "@arcforge/link"

/** Boot-stage tracing, for diagnosing an agent that comes up but never reports. */
const trace = (stage: string) => {
    if (process.env.AXON_TRACE_BOOT) process.stderr.write(`[boot] ${stage}\n`)
}

export async function main(): Promise<void> {
    trace("start")
    const paths = readLinkEnv()

    const blueprintPath = process.env[AGENT_BLUEPRINT_ENV]
    if (!blueprintPath) {
        throw err("AGENT_BLUEPRINT_MISSING", { detail: `${AGENT_BLUEPRINT_ENV} is not set`, context: { env: AGENT_BLUEPRINT_ENV } })
    }
    const blueprint = JSON.parse(readFileSync(blueprintPath, "utf-8")) as AxonPartialBlueprint

    // The one thing JSON could not carry.
    await rehydrateServer(blueprint)

    // Deferred: the handlers need the runtime, and the runtime needs the link
    // to commit through. Neither can be built first, so the handlers close
    // over a slot that is filled once the runtime exists.
    /**
     * Verbs arriving before the runtime exists WAIT rather than fail.
     *
     * The link connects before Axon() runs — deliberately, so a boot failure
     * is reportable — which leaves a window where the agent is addressable but
     * not yet able to answer. A caller that sent during that window got
     * AGENT_NOT_READY, and because the throw happened inside the channel's
     * dispatch it took the whole process down: the TUI sent a message, the
     * agent refused and died, and neither the message nor a reply ever
     * appeared.
     *
     * Waiting is the honest behaviour. A stimulus sent to a booting agent is
     * not an error — it is early, and boot is measured in seconds. The wait
     * ends when the runtime is ready, or rejects with the real reason if boot
     * fails.
     */
    let serving: ReturnType<typeof AgentRuntime> | null = null
    /** An interrupt that arrived before the runtime existed — replayed at ready. */
    let pendingInterrupt: "user" | "shutdown" | null = null
    let markReady!: () => void
    let markFailed!: (error: Error) => void
    const ready = new Promise<void>((resolve, reject) => {
        markReady = resolve
        markFailed = reject
    })

    const handlers = agentHandlers({
        stimulus: entry => serve().then(s => s.stimulus(entry)),
        ingest: entry => serve().then(s => s.ingest(entry)),
        update: bp => serve().then(s => s.update(bp)),
        /**
         * Interrupt is sync and fire-and-forget — but it must not be LOST.
         *
         * `serving?.interrupt()` silently dropped an interrupt that arrived
         * while the runtime was still booting. That window is exactly when a
         * user is most likely to press Escape: a slow boot looks like a hung
         * agent, and the one thing they can do is cancel.
         *
         * Recorded and replayed instead. Sync by contract, so it cannot await
         * the runtime — the flag is what carries the intent across the gap.
         */
        interrupt: reason => {
            if (!serving) {
                pendingInterrupt = reason
                return
            }
            serving.interrupt(reason)
        },
        /**
         * Drain, answer, then LEAVE.
         *
         * The exit is deliberate rather than left to the event loop draining
         * on its own. An agent holds a cognet, a capsule, sockets and
         * whatever a module's setup() opened; any one of those keeping a
         * handle alive turned "shutdown" into "linger until the supervisor
         * gives up and kills it" — five seconds of dead time on every
         * `axon -s`, with all the work already finished.
         *
         * Deferred one turn so the reply reaches the supervisor first: exiting
         * inside the handler drops the response, and the caller then waits out
         * its own timeout for an answer that will never arrive.
         */
        shutdown: () => serve().then(async s => {
            await s.shutdown()
            setTimeout(() => process.exit(0), 0).unref?.()
        }),
        request: entry => serve().then(s => s.request(entry)),
        run: code => serve().then(s => s.run(code)),
        prompts: request => serve().then(s => s.prompts(request)),
        // `serve()` here is the READINESS gate (wait for the runtime), not
        // the HTTP verb — the agent binds its port only once its routes
        // exist, which is exactly what that gate guarantees.
        serve: port => serve().then(s => s.serve(port)),
    })
    async function serve() {
        if (!serving) await ready
        // Unreachable unless `ready` resolved without the runtime being set,
        // which would be a wiring fault rather than a timing one.
        if (!serving) throw err("AGENT_NOT_READY", { detail: "the runtime never became available" })
        return serving
    }

    const channels = await connect({
        paths,
        ...handlers,
        onError: error => process.stderr.write(`agent link error: ${error.message}\n`),
    })

    trace("connected")
    const supervisor = supervisorProxy(channels)

    /**
     * Boot the runtime, REPORTING any failure through the link before dying.
     *
     * The link is deliberately connected first, so that a boot failure is
     * reportable at all — but that only helps if something actually reports
     * it. Without this the sequence was: link connects, Axon() throws, the
     * process exits, the socket closes, and the supervisor says
     * LINK_PEER_CLOSED. The agent knew exactly what was wrong (a missing
     * cognet, a tool that would not compile) and took the diagnosis with it.
     *
     * Committed rather than written to stderr, because the supervisor owns
     * this agent's log and a boot failure belongs in the record beside every
     * other thing that happened to it.
     */
    /**
     * Forward every event to the supervisor, which owns the log.
     *
     * Buffered until the runtime exists, because the bus this subscribes to is
     * BUILT BY Axon() — and everything it announces during boot
     * (axon:boot:start, the agent's identity, its blueprint) is emitted before
     * that call returns. Subscribing afterwards silently dropped all of it,
     * which is why the TUI's header came up blank: the facts it renders had
     * already gone past.
     */
    const pending: Array<{ type: string; data: unknown; ctx?: AxonCommitContext }> = []
    let forward = (type: string, data: unknown, ctx?: AxonCommitContext) => { pending.push({ type, data, ctx }) }

    /**
     * The bus, built HERE and handed to Axon() — so this can subscribe
     * BEFORE boot rather than after it.
     *
     * Everything boot announces (axon:boot:start, the kernel coming up,
     * each module's setup, every tool load) fires during the `Axon()` call.
     * Subscribing to `runtime.bus` afterwards is subscribing to a stream
     * whose first act is already over. Those events went into the record
     * anyway while the agent wrote its own log; once the supervisor became
     * the only writer, they had nowhere to go and silently disappeared.
     */
    const bus = AxonBus()
    bus.onAny((type: string, payload: unknown) => announce(type, payload))

    let runtime: Awaited<ReturnType<typeof Axon>>
    try {
        runtime = await Axon({
            blueprint,
            bus,
            // The two facts that make this runtime confined:
            //   remote — inference crosses the link, so no credential is here
            //   (tools then load in this heap, see Axon())
            remote: role => RemoteDriver({ role, supervisor }),
        })
    } catch (cause) {
        const failure = err(cause)
        supervisor.commit("axon:boot:failed" as never, {
            error: failure.toJSON(),
            durationMs: 0,
        } as never)
        // Give the commit a turn to reach the wire before the process ends —
        // it is fire-and-forget, and an exit here would drop it.
        await new Promise(resolve => setTimeout(resolve, 100))
        // Anything waiting on the runtime gets the real reason, not a timeout.
        markFailed(failure)
        throw failure
    }

    trace("axon-booted")
    // No cast: RuntimeForAgent names exactly what the link needs from the
    // runtime — the kernel verbs, the prompt surface, and the server whose
    // handler `serve` binds. An `as never` here used to hide a missing
    // member until it failed at call time.
    serving = AgentRuntime(runtime)
    markReady()

    // An Escape pressed during boot applies to the wake that boot was for.
    if (pendingInterrupt) {
        serving.interrupt(pendingInterrupt)
        pendingInterrupt = null
    }

    // Every event this runtime records goes to the supervisor, which owns the
    // log. The agent may APPEND to the record and can never rewrite it — an
    // attacker able to edit the audit trail has erased the evidence of
    // everything else.
    /**
     * The bus carries the WHOLE ENVELOPE, not the bare payload: `session.commit`
     * announces through `bus.forward(event)`, which emits `{ type, time, data }`
     * under the event's own name. Forwarding that straight into
     * `commit(type, data)` re-wraps it — the supervisor stores `data.data.meta`
     * and every reader looking for `data.meta` finds undefined.
     *
     * Unwrapped HERE rather than on the far side, because this is where the
     * shape is known: the supervisor receives (type, data) and cannot tell an
     * envelope from a payload that happens to have a `data` field of its own.
     */
    /**
     * The correlation half of an envelope's context, for the wire.
     *
     * `agentId` and `sessionId` are the SUPERVISOR's to stamp — it owns the
     * session and knows both — so sending them back would be the child
     * asserting its own identity to the thing that assigned it. Only the ids
     * the child actually mints travel: runId and spanId.
     *
     * Returns undefined when neither is present, so an event with no
     * correlation commits with no context rather than an empty object.
     */
    function contextOf(context: AxonCommitContext | undefined): AxonCommitContext | undefined {
        if (!context) return undefined
        const { runId, spanId } = context
        if (!runId && !spanId) return undefined
        return { ...(runId ? { runId } : {}), ...(spanId ? { spanId } : {}) }
    }

    function announce(type: string, payload: unknown): void {
        /**
         * Two shapes travel this bus, and the difference is not cosmetic.
         *
         * Everything committed goes through `session.commit`/`commitEntry`,
         * which announce via `bus.forward(event)` — a full ENVELOPE,
         * `{ type, time, context, data }`. But the kernel forwards TRANSIENT
         * capsule events raw (`kernel/src/capsule.ts`: `bus.forward(event)`
         * where event is `{ type, ...fields }`), so those arrive with their
         * fields at the top level and no `data` at all.
         *
         * Reading `envelope.data` off both was the bug behind the markdown
         * crash: a raw event has no `data`, so the whole object — `type`
         * included — was committed AS the payload, and a reader doing
         * `data.content` got an object where the contract promised a string.
         *
         * Discriminated on `time`, which the envelope stamps and a raw event
         * never carries. Explicit rather than a "has data" sniff, because a
         * payload with its own `data` field is a shape nobody should have to
         * reason about at this seam.
         */
        const carrier = payload as {
            time?: unknown
            data?: unknown
            type?: unknown
            context?: AxonCommitContext
        } | undefined
        if (carrier && typeof carrier === "object" && "time" in carrier) {
            // The context travels WITH the payload, as its own argument.
            // Unwrapping the envelope and dropping `context` is what silently
            // un-correlated every span once agents moved into subprocesses:
            // the kernel mints one spanId per engine call, start/input/
            // complete share it, and nothing else joins them. The supervisor
            // re-envelopes on the far side, so this is the only place the ids
            // can be handed over.
            forward(type, carrier.data, contextOf(carrier.context))
            return
        }
        // A raw event: strip the name it already travels under, keep the rest.
        if (carrier && typeof carrier === "object" && "type" in carrier) {
            const { type: _name, ...fields } = carrier as Record<string, unknown>
            forward(type, fields)
            return
        }
        forward(type, payload)
    }

    // Live from here — and everything boot produced goes first, in order.
    forward = (type, data, ctx) => { supervisor.commit(type as never, data as never, ctx) }
    for (const event of pending.splice(0)) forward(event.type, event.data, event.ctx)

    /**
     * The agent's last words.
     *
     * Without this an unhandled throw kills the process and the supervisor
     * sees only a socket close — the actual error dies with the process it
     * happened in. Same reasoning as the capsule's own crash handler, and the
     * same deliberate immediate exit: an unhandled error means state is
     * unknown, and an agent that keeps serving after that is worse than one
     * that dies loudly.
     */
    for (const event of ["uncaughtException", "unhandledRejection"] as const) {
        process.on(event, (cause: unknown) => {
            supervisor.commit("axon:log:error" as never, {
                message: cause instanceof Error ? cause.message : String(cause),
            } as never)
            process.exit(1)
        })
    }

    /**
     * An agent with no supervisor has nobody to serve — so it exits.
     *
     * The `exit` handler on the supervisor side covers a clean shutdown and an
     * unhandled throw, but not SIGKILL: kill -9 the TUI and nothing runs. The
     * agent notices the same event from its own side — both channels closing —
     * and stops itself.
     *
     * This is what keeps a crashed supervisor from leaving an agent holding a
     * cognet, a capsule and two sockets indefinitely. Deliberately not a
     * timeout: a closed socket is a fact, and waiting on one is not.
     */
    const watchdog = setInterval(() => {
        if (channels.control.isClosed && channels.data.isClosed) {
            trace("orphaned")
            process.exit(0)
        }
    }, 1_000)
    // Never hold the process open on our own account.
    watchdog.unref?.()

    // Readiness is the SOCKET connecting, which the supervisor already races
    // against process exit — nothing ever read this line. It stayed harmless
    // only while the agent's stdout went to an unread pipe; now that stdout
    // is the agent's own output forwarded to the user's terminal, a boot
    // marker printed there is noise on every single run.
    trace("ready")
}

/**
 * Rebuild the authored server surface, agent-side.
 *
 * The blueprint reaches this process as JSON, and routes, middleware and
 * plugins are the three things on it that are FUNCTIONS. `JSON.stringify`
 * drops a function silently, so each entry arrived carrying its metadata and
 * nothing to call: `mountRoute` registered a route whose handler was
 * `undefined`, h3 accepted it, and every request to an authored path 404'd
 * with no warning at either end.
 *
 * Middleware was the dangerous half. Its own type doc calls a dropped
 * middleware "a request path running without the checks its author wrote — a
 * security hole that looks like a working server", and that is exactly what
 * shipped: an agent whose auth middleware silently did not run.
 *
 * SCANNED here rather than re-resolved from a file path on each entry.
 * Routes carry `file` and could have been recovered that way, but middleware
 * and plugins carry none — and the deeper reason is the same one that put the
 * agent in its own cwd: the agent owns what it is, rather than depending on
 * what the caller managed to marshal across. The supervisor's copy of these
 * lists is now advisory; this is the one that runs.
 *
 * Order is preserved exactly as the supervisor assembles it (see
 * blueprint.ts): the agent's own entries first, then each module's in
 * declaration order. Routes mount first-wins, and the agent's middleware
 * gates before any module's — a module must not be able to slip a handler
 * ahead of an auth check the author wrote.
 */
async function rehydrateServer(blueprint: AxonPartialBlueprint): Promise<void> {
    const root = blueprint.paths?.root
    if (!root) return

    const roots: Array<{ root: string; required: boolean }> = [
        // The agent's own source is required: an agent running a subset of
        // what its author wrote is an agent nobody asked for.
        { root, required: true },
        // A module's is not. An agent that installed a broken module is the
        // agent it was before the install, and crashing here would leave the
        // user unable to boot the terminal they need to remove it.
        ...(blueprint.modules ?? []).map(module => ({ root: module.root, required: false })),
    ]

    const routes: AxonRoute[] = []
    const middleware: AxonMiddleware[] = []
    const plugins: AxonPlugin[] = []

    for (const source of roots) {
        const opts = { required: source.required }
        const [scannedRoutes, scannedMiddleware, scannedPlugins] = await Promise.all([
            Routes(source.root, opts),
            Middleware(source.root, opts),
            Plugins(source.root, opts),
        ])
        routes.push(...scannedRoutes.entries)
        middleware.push(...scannedMiddleware.entries)
        plugins.push(...scannedPlugins.entries)
    }

    blueprint.server = { routes, middleware, plugins }
}

// Run only when executed directly, never on import — the tests import `main`
// and the module must not boot an agent as a side effect of being read.
if (import.meta.main) {
    await main()
}
