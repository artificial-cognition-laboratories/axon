import type { AxonEngineRawEvent, AxonEngineRequest } from "./engine"
import type { AxonRunResult } from "./kernel/abi"
import type { AxonBlueprint } from "./blueprint"
import type { AxonEventMap } from "./session/session"
import type { AxonStimulusEntry } from "./session/events/stdio/stimuli"
import type { EscalationCall } from "./policy"

/**
 * The supervisor ↔ agent wire.
 *
 * ── What the boundary is FOR ────────────────────────────────────────────────
 *
 * One confined process per agent: cognet, tools, scripts, routes and
 * model-emitted code all in one heap, bounded by an OS box (bwrap mount/pid/
 * net namespaces + cgroup limits). Everything in that box is agent-side code
 * at one trust level — distinct AUTHORSHIP (a registry cognet, an agent
 * author, the model) but identical AUTHORITY, all narrowed by the user's
 * profile ceiling.
 *
 * The supervisor holds what must never enter that box. The rule that decides
 * membership, and the only one worth remembering:
 *
 *   An asset whose loss is UNRECOVERABLE and whose stolen form is PORTABLE
 *   must never enter the untrusted process. Vend a capability to use it.
 *
 * A stolen file is one machine's data. A stolen provider key is a live
 * capability that works from anywhere, forever, until someone notices and
 * rotates it. That asymmetry is why `infer` streams across this wire instead
 * of the agent simply being handed a token: the agent can CAUSE inference, and
 * can never obtain, transfer, or outlive the credential that performs it.
 *
 * The same reasoning keeps the session log outside — an attacker who can
 * rewrite the audit trail has erased the evidence of everything else — and
 * keeps `escalate` outside, because a program able to reach the decider could
 * answer its own escalations.
 *
 * ── What is deliberately NOT here ───────────────────────────────────────────
 *
 * `store` and `knowledge` live INSIDE the box. They are the agent's own state;
 * the supervisor gains nothing by mediating a kv the agent owns, and their
 * stolen form is not portable. Keeping them in cuts four verbs.
 *
 * `run`, `scope` and the rest of KernelAbi are gone from the wire entirely.
 * They are the cognet talking to its own kernel, and after the reshuffle both
 * are in the same heap — putting them here would re-create, one layer out, the
 * boundary this exists to remove.
 *
 * ── Direction ───────────────────────────────────────────────────────────────
 *
 * The dominant direction INVERTS versus the capsule wire. That one carried
 * "run this code" host→guest, with a reverse channel bolted on. Here the guest
 * drives: inference, telemetry and escalation all flow agent→supervisor, and
 * that is the hot path.
 */

// ── supervisor → agent ───────────────────────────────────────────────────────

/**
 * Everything the outside can say to a running agent.
 *
 * Note there is NO `wake`. The outside emits a STIMULUS and the brain decides
 * whether to wake for it — that is the scheduler's own admission policy
 * (kernel/src/scheduler), which may legitimately drop a stimulus arriving
 * mid-wake. A `wake()` verb on the wire would steamroll that decision from
 * outside the mind it belongs to.
 */
export type SupervisorToAgent = {
    /**
     * Deliver a stimulus. Resolves on ADMISSION, never on completion.
     *
     * A continuous cognet is ticked by its own plugin and wakes whether or not
     * the last wake finished; resolving on completion here would serialise
     * that overlap and turn a mind under a clock into a queue. Admission is
     * the contract — see Scheduler's `reserve({ exclusive })`.
     */
    stimulus(entry: AxonStimulusEntry): Promise<{ admitted: boolean }>

    /** Hot reload: a re-normalised blueprint replaces the live one. */
    update(blueprint: AxonBlueprint): Promise<void>

    /**
     * Abort the active wake.
     *
     * Out-of-band on the CONTROL channel, which is the reason there are two
     * channels at all: an interrupt must land WHILE inference is streaming,
     * and on one line-buffered pipe it would queue behind exactly the traffic
     * it exists to stop. The capsule papered over this by killing and
     * rebuilding its subprocess (a hard reset racing a 50ms timeout); a
     * separate channel removes the need.
     */
    interrupt(reason: "user" | "shutdown"): void

    /** Drain and exit. The supervisor SIGKILLs if this does not settle in time. */
    shutdown(): Promise<void>

    /**
     * Deliver a stimulus and wait for the wake it caused to SETTLE.
     *
     * The completion counterpart to `stimulus`, and the reason both exist.
     * `stimulus` answers "did the brain admit this" and returns immediately,
     * which is the only honest answer for a continuous cognet whose wakes
     * overlap. But an interactive caller — someone typing at a terminal — needs
     * to know when the reply is finished, and a UI that renders a spinner
     * forever because nothing said "done" is broken in a way that admission
     * cannot fix.
     *
     * Resolves on the wake's own bracket closing (`kernel:run:complete` /
     * `:failed` / `:interrupted`), which the agent already commits — so this
     * verb reads a signal that exists rather than inventing one.
     *
     * REFUSED for a continuous cognet: several wakes may be in flight, so
     * "the wake this stimulus caused" names nothing. Such a caller wants
     * `stimulus` and the commit stream.
     */
    request(entry: AxonStimulusEntry): Promise<{ ok: boolean; interrupted?: boolean }>

    /**
     * Bind the agent's HTTP surface, inside the box, and report the port.
     *
     * The AGENT owns its server: routes, middleware and plugins are agent
     * code, and the handler they compose lives in the agent's heap. A
     * supervisor-side proxy would have to re-implement HTTP semantics over
     * this channel — streaming responses most of all — to serve routes it
     * cannot see.
     *
     * Constrained the way any HTTP service is: by the auth middleware in
     * front of it, not by the absence of a socket.
     *
     * Walks forward from `port` when it is taken (Nuxt/Vite behaviour), so
     * the bound port comes BACK rather than being assumed — a caller
     * printing a URL must print the one that answers.
     *
     * Idempotent: serving an already-served agent returns the live port
     * rather than binding a second socket.
     */
    serve(port: number): Promise<{ port: number }>

    /**
     * Execute code in the agent's scope — the console/devtools eval.
     *
     * The same conversation a model-emitted `<typescript>` block gets: same
     * mediation, same policy, same span events. `origin: "host"` marks it as
     * a human's request rather than the model's, so the timeline can tell them
     * apart — a debugging eval that looked like cognition would corrupt the
     * record of what the agent decided on its own.
     *
     * A VERB rather than a stimulus, because it is not something the brain
     * decides about: nothing wakes, no wake admits it, and the caller wants
     * the value back.
     */
    run(code: string): Promise<AxonRunResult>

    /**
     * The agent's prompt surface — list, fetch one, render an entry.
     *
     * One verb with a discriminated action rather than three, for the same
     * reason `commit` is one verb: the supervisor's job is identical for each
     * and three near-identical round trips would be three places to keep in
     * step.
     */
    prompts(request: PromptRequest): Promise<unknown>
}

/** What a caller wants from the agent's prompt surface. */
export type PromptRequest =
    | { action: "list" }
    /**
     * Render a declared prompt. `props` are the prompt's own parameters —
     * a `.vue` prompt's `defineProps`, or a static one's (ignored) — carried
     * because a prompt WITH props is unrenderable without them, and the
     * caller that has them is on this side of the link.
     */
    | { action: "get"; name: string; props?: Record<string, unknown> }
    | { action: "render"; entry: unknown }

// ── agent → supervisor ───────────────────────────────────────────────────────

/**
 * One inference call, as it crosses the wire.
 *
 * The boundary lands on a seam that already existed: `AxonEngineDriver` is
 * documented as "a dumb token pipe: messages in, raw deltas out — no AIR
 * parsing, no bus, no blocks", while the Engine() MANAGER owns parsing,
 * retries, telemetry and the stall guard. The driver stays supervisor-side
 * because it holds the credential; the manager moves agent-side because it is
 * cognition-adjacent.
 *
 * So what crosses is `AxonEngineRawEvent` — three variants of {type, content}.
 * AIR never crosses. The supervisor never learns what the model sees, which is
 * what the kernel already claimed and only now becomes structurally true.
 */
export type InferCall = {
    /** Which declared ROLE to infer with. The agent never names a model or a key. */
    role: string
    request: AxonEngineRequest
}

export type AgentToSupervisor = {
    /**
     * Stream inference for one call. THE hot path.
     *
     * Back-pressures naturally: the agent consumes this as an async generator,
     * so a slow consumer fills the socket buffer and the supervisor stops
     * draining the driver. That only holds if the transport respects it —
     * which is why this is not a fire-and-forget write like `commit`.
     *
     * The idle-stall guard (`STREAM_IDLE_DEFAULT_MS`) stays with the MANAGER,
     * agent-side: it is the consumer, and it is the thing that must not hang.
     */
    infer(call: InferCall, signal: AbortSignal): AsyncGenerator<AxonEngineRawEvent>

    /**
     * Append one event to the session log.
     *
     * ONE verb, not five. `output()`, `emit()`, `fault()`, `proc:*` and `fn:*`
     * are separate paths today that all end at `session.commit`; the
     * supervisor's job is identical for every one of them — append, then
     * forward to the bus. Collapsing them keeps the wire honest about what is
     * actually happening.
     *
     * FIRE-AND-FORGET but strictly ORDERED. It is the audit trail: two writers
     * interleaving would corrupt the record of what happened, so a single
     * writer per agent is an invariant of the transport, not an accident of it.
     *
     * The event NAMES are unchanged (`capsule:*` included) — Fleet folds the
     * flame graph and the process tree straight out of this stream, so keeping
     * the vocabulary keeps every existing surface working across the move.
     */
    commit<K extends keyof AxonEventMap>(type: K, data: AxonEventMap[K]): void

    /**
     * Ask a human about one call. Resolves with the verdict.
     *
     * Outside the box because a program that could reach the decider could
     * raise and answer its own escalations. Fails CLOSED on timeout — and
     * commits a record before it does: the mediator's remaining job after the
     * OS wall takes over is escalation and audit, so an unrecorded timeout is
     * a hole in its only function.
     */
    escalate(call: EscalationCall): Promise<{ allow: boolean }>
}

/**
 * The transport contract.
 *
 * TWO channels, because `interrupt` must not queue behind `infer`. Framed
 * datagrams (SOCK_SEQPACKET) rather than line-delimited JSON: each message is
 * atomic, so there is no partial-line buffering and no length-prefix parsing,
 * and the `undefined`→`null` replacer the JSONL wire needed has nothing to fix.
 */
export type AgentTransport = {
    /** Control: stimulus/update/interrupt/shutdown, escalate. Never blocked by inference. */
    control: "control"
    /** Data: the infer stream and the commit log. */
    data: "data"
}
