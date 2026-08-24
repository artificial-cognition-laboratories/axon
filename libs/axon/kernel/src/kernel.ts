import { err } from "@arcforge/err"
import type { AxonBlueprint, AxonDriver, AxonEngineCall, AxonEngineEvent, AxonEntry, AxonEntryEvent, AxonEventMap, AxonRunResult, CapsuleCommandOrigin, EngineSession, KernelAbi, TransformOptions } from "@arcforge/types"
import { EMPTY_CAPSULE_SCOPE } from "@arcforge/types"
import type { AxonCloudClient } from "@arclabs/cloud"
import type { KernelBus } from "./contracts"
import { Engine } from "./engine"
import { asEngineFault } from "@arcforge/engines"
import type { EnginesT } from "@arcforge/engines/catalogue"
import type { AxonSessionT } from "@arcforge/session"
import { AxonCapsule, type AxonCapsuleT } from "./capsule"
import { Scheduler } from "./scheduler"
import type { KernelCognet } from "./contracts"
import { Store } from "./store"
import { Knowledge } from "./knowledge"
import type { AxonEscalate, AxonHost } from "@arcforge/types"

type KernelOpts = {
    blueprint: AxonBlueprint
    /** Immutable host invocation directory for this runtime's userland. */
    cwd: string
    bus: KernelBus
    /** The runtime's cloud client — engines resolve vault-backed provider tokens through it. */
    cloud: AxonCloudClient
    /** The brain — the runtime's handle over the blueprint-carried cognet artifact. Always present. */
    cognet: KernelCognet
    /**
     * The session is environmental — constructed once at the Axon() seam,
     * alongside bus/cloud, and handed to every consumer that needs it
     * (Kernel, AxonRuntime, AxonHandle). Kernel does not own it and does
     * not close it; it only reaches session through the ABI's output()/
     * run(), which is the one real privilege boundary this file enforces
     * (the untrusted cognet may only emit/request, never read or write the
     * log directly). No thread concept: one cognet instance is always
     * exactly one continuous stream.
     */
    session: AxonSessionT
    /**
     * The agent's base identity text, rendered fresh per call — backs the
     * ABI's base(). Injected because rendering it is a PRESENTATION concern
     * (boot.vue, the vstr renderer, the prompt context) that ring 0 has no
     * business owning: the kernel guards the user's identity contract, it
     * does not decide how that identity is produced.
     */
    base: () => Promise<string>
    /**
     * Re-render base() against a new blueprint on reload. Paired with `base`:
     * whoever owns producing the identity text owns refreshing it, so ring 0
     * fans the blueprint out without knowing what produces it.
     */
    onUpdate?: (blueprint: AxonBlueprint) => void
    host?: AxonHost
    /**
     * The platform's policy decider — consulted when a rule says "escalate".
     *
     * Host-side, never routed through AxonHost: that is the guest's channel,
     * and a sandboxed program able to reach the decider could raise or answer
     * its own escalations. Absent = no decider, which the capsule treats as
     * deny — the honest state for a headless run.
     */
    escalate?: AxonEscalate
    /**
     * Resolved inference roles, when the cognet declared any.
     *
     * Built at the Axon() seam rather than here, for the same reason session
     * and cloud are: gathering catalogues is network work against the user's
     * declared providers, and construction inside ring 0 would put an fs/net
     * dependency in the one place that must stay a pure syscall table.
     * Absent for a cognet on the single-`engine:` path.
     */
    engines?: EnginesT
}

type KernelInput = {
    /** User message committed before the wake starts. */
    content?: string | string[]
    /**
     * The surface this message arrived on, and the address a reply goes back
     * to — `terminal`, `axon-cli`, `telegram:8199237521`.
     *
     * Named by whoever emits it, not by the kernel: the runtime has no way to
     * know which surface it is embedded in, and a hardcoded value made every
     * host claim to be the same one. Defaults to `terminal` for a caller that
     * says nothing, which is what a direct `request()` effectively is.
     */
    channel?: string
    /**
     * The structured shape this invocation must produce, already compiled by
     * the caller (Axon's handle) so a bad type throws at the call site,
     * before a wake is ever scheduled. Enforced by the engine; invisible to
     * the cognet.
     */
    output?: AxonEngineCall["output"]
    /** Attempts after a response fails `output`. Ignored without one. */
    retries?: number
}

const COGNET_EVENT_PREFIX = "cognet:"

/** Render a run's completion value for the visible tool-call log. Strings pass through; everything else is JSON. */
/**
 * How much of one action's output may reach the log, and so the context.
 *
 * A backstop, not a policy: tools are expected to bound their own results
 * (fs.query has a line budget for exactly this reason), and this catches the
 * ones that do not. A single call once returned 244k characters — ~61k tokens
 * — which quadrupled the context in one tick and stalled the run that read it.
 *
 * Generous enough that ordinary output is untouched: a full file read, a long
 * build log, a wide directory listing all fit well inside it. What does not
 * fit is a result nobody could read anyway.
 */
const MAX_RESULT_DEFAULT_CHARS = 40_000

/** Read per call, not captured at import — see streamIdleMs in engine.ts. */
const maxResultChars = (): number => Number(process.env.AXON_MAX_RESULT_CHARS) || MAX_RESULT_DEFAULT_CHARS

/**
 * Truncate an oversized result, and SAY SO in the result itself.
 *
 * The marker is the point. A silently trimmed result teaches the model that
 * its query was fine and the data was small, so it never narrows — whereas a
 * result that names its own truncation, and by how much, is a fact the model
 * can act on. Both ends are kept because the tail of a command's output is
 * usually where the answer or the error is.
 */
function capResult(content: string): string {
    const max = maxResultChars()
    if (content.length <= max) return content

    const keep = Math.floor(max / 2)
    const head = content.slice(0, keep)
    const tail = content.slice(-keep)
    const dropped = content.length - keep * 2
    return `${head}\n\n[... ${dropped.toLocaleString()} characters truncated of ${content.length.toLocaleString()} total — `
        + `narrow the query (fewer files, less context, a more specific pattern) to see the rest ...]\n\n${tail}`
}

/**
 * A returned value, as the model reads it.
 *
 * COMPACT, not pretty-printed. `JSON.stringify(v, null, 2)` spends 46% of its
 * output on indentation — measured on a real result, 58% of the whole payload
 * was whitespace and structural punctuation — and none of it helps a reader
 * that does not need the tree aligned to parse it. A 40k-char result becomes
 * 24k with no information removed, which is 4k tokens of context back on every
 * call that returns a structure.
 *
 * The saving compounds: results are the largest thing in a long run's context
 * (174k of a 300k prompt, in the run that motivated this), so indentation was
 * the single biggest avoidable cost in the loop.
 *
 * Strings pass through untouched — a file's contents are already the shape the
 * model wants, and quoting them would be the same mistake in the other
 * direction.
 */
function formatValue(value: unknown): string {
    if (value === undefined) return ""
    if (typeof value === "string") return value
    try {
        return JSON.stringify(value) ?? ""
    } catch {
        return String(value)
    }
}

/**
 * What a caller may say about a capsule execution.
 *
 * `origin` is provenance, never privilege — see CapsuleCommandOrigin. The
 * cognet path never sets it (absent means "cognet"); only a developer
 * surface executing code against a live agent does.
 */
export type RunOptions = { signal?: AbortSignal; origin?: CapsuleCommandOrigin }

/** Thrown by a script that was cancelled before it started — see runAndCommit. */
function interruptedError(signal: AbortSignal): DOMException {
    return new DOMException(String(signal.reason ?? "user"), "AbortError")
}

/**
 * The result shape for a script the wake cancelled before it ran.
 *
 * A settled `AxonRunResult` rather than a rejection, because the batch's other
 * blocks DID run and a caller reading `results[i]` must still get block i. The
 * `interrupt` kind already exists on the ABI for exactly this outcome, so a
 * consumer that handles a timed-out or interrupted block handles this with no
 * new case.
 */
function interruptedResult(reason: unknown): AxonRunResult {
    return {
        ok: false,
        stdout: [],
        scope: EMPTY_CAPSULE_SCOPE,
        error: {
            kind: "interrupt",
            message: reason instanceof Error ? reason.message : String(reason),
        },
    }
}

/**
 * Run one block against the capsule and normalize the outcome — the ABI
 * boundary this seam exists for. Exec() below (capsule's own contract)
 * still rejects; a program should never have to catch three different
 * shapes (AbortError, timeout Error, plain Error) to know what happened,
 * so this is the one place that catch lives. Console output is captured
 * here too (via the capsule's own onConsole, never exposed past this
 * function) and returned inline — the kernel already auto-forwards the
 * capsule's full event stream to the bus untranslated, so a program that
 * wants live output subscribes to that; a program that wants ITS OWN run's
 * output back as part of the result reads `stdout` here, no callback wired
 * by hand.
 */
async function runOne(capsule: AxonCapsuleT, code: string, opts?: { signal?: AbortSignal; id?: string; origin?: CapsuleCommandOrigin }): Promise<AxonRunResult> {
    const stdout: string[] = []
    const onConsole = (level: string, args: unknown[]) => {
        const line = args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")
        stdout.push(level === "log" || level === "info" ? line : `[${level}] ${line}`)
    }

    try {
        // exec() rather than run(): the bindings come back alongside the
        // value, so a cognet rendering a template from the same turn has
        // something to interpolate against.
        const { value, scope } = await capsule.current.exec(code, { onConsole, signal: opts?.signal, id: opts?.id, origin: opts?.origin })
        return { ok: true, value, stdout, scope }
    } catch (cause) {
        const interrupted = opts?.signal?.aborted || (cause instanceof Error && cause.name === "AbortError")
        const timedOut = cause instanceof Error && /timed out/.test(cause.message)
        return {
            ok: false,
            stdout,
            // A block that threw declared nothing usable — an empty scope is
            // the honest value, and keeps callers from having to test for
            // absence before every interpolation.
            scope: EMPTY_CAPSULE_SCOPE,
            error: {
                kind: interrupted ? "interrupt" : timedOut ? "timeout" : "exception",
                message: cause instanceof Error ? cause.message : String(cause),
            },
        }
    }
}

/**
 * Kernel — the agent's OS. Owns resources and execution, never cognition.
 *
 * Ring 0: the trusted machinery — engine (inference), scheduler (process
 * management), the capsule's constructor. Ring 3: the capsule — the
 * unprivileged userland every agent-emitted effect runs in; the kernel is
 * its ONLY constructor, and security is enforced at that process boundary
 * alone.
 *
 * Session is NOT kernel-owned — it's environmental, constructed once at
 * the Axon() seam and handed in here like bus/cloud. The kernel's only
 * relationship to it is mediating the cognet's access: the ABI's output()
 * and run() are the only doors, and both commit on the cognet's behalf —
 * it never touches session.commit directly. Every other consumer (Axon(),
 * AxonRuntime, AxonHandle) reaches session directly — going through the
 * kernel to commit a runtime event was the original design mistake this
 * replaces.
 *
 * Cognition lives in the COGNET — a versioned artifact carried in on the
 * blueprint, exec'd here once, and woken per stimulus (or per tick, for a
 * continuous-mode cognet — see scheduler/). The cognet touches nothing but
 * the ABI built here; the kernel never learns what the model sees or how
 * the brain thinks. Grammar, rendering, strategy: all above this line's
 * pay grade. No thread concept anywhere in this file: one cognet instance
 * is always exactly one continuous stream against the session's one log;
 * multiple independent conversations are multiple Axon() instances, a
 * host-level (TUI) concern this file has no opinion on.
 *
 * The kernel exists to protect user resources from the cognet. The cognet
 * is the unprivileged brain that uses the user's resources as per policy.
 */
export async function Kernel(opts: KernelOpts) {
    const cognet = opts.cognet
    const session = opts.session

    const scheduler = Scheduler({
        bus: opts.bus,
        session: session,
    })

    const capsule = await AxonCapsule({
        boot: true,
        blueprint: opts.blueprint,
        bus: opts.bus,
        session: session,
        run: () => scheduler.current(),
        cwd: opts.cwd,
        ...(opts.host ? { host: opts.host } : {}),
        ...(opts.escalate ? { escalate: opts.escalate } : {}),
    })

    const engine = Engine({
        ...(opts.engines ? { engines: opts.engines } : {}),
        blueprint: opts.blueprint,
        session,
        cloud: opts.cloud,
        // Reporting a format violation is the kernel's to commit — the
        // engine describes the fault, the session records it. Injected
        // rather than reached for, so the engine never learns what a session
        // is. Hoisted declaration; live before the first call.
        fault: input => recordFault(input, scheduler.active()).then(() => {}),
    })

    const store = Store({
        blueprint: opts.blueprint,
        cognet: cognet,
        session: session,
    })

    /**
     * Long-term knowledge — the agent's own data/knowledge/ plus every
     * module's, discovered by the build and carried on the blueprint.
     *
     * Entries rather than a directory to walk: a module's corpus stays in its
     * own package, so the runtime is handed paths the same way it is handed
     * resolved model weights. Writes still resolve against the AGENT root
     * (paths.root, not paths.data — authored input, not runtime output), and
     * module material is read-only.
     *
     * Mutations commit through the kernel, never the cognet: same rule as
     * run()'s action/result pair — the brain requests, the kernel records.
     *
     * Fire-and-forget, because the write already succeeded and resolved to the
     * caller — there is no honest way to fail it after the fact, and telemetry
     * must never take down the runtime it observes.
     *
     * But NOT silent. This is the audit record for "the agent rewrote its own
     * long-term memory", which is exactly the fact you want when behaviour
     * drifts weeks later; a bare catch would let the ledger disagree with the
     * filesystem with nothing anywhere to say so. Routing the rejection
     * through err() delivers it to the runtime's error sink — the record
     * still shows something went wrong, without the append becoming fatal.
     */
    const knowledge = Knowledge({
        root: opts.blueprint.paths.root,
        entries: opts.blueprint.knowledge,
        onMutate: (event, name) => {
            void session
                .commit(`cognet:knowledge:${event}`, { name }, scheduler.current() ?? undefined)
                .catch((cause) => {
                    err("KNOWLEDGE_RECORD_FAILED", {
                        detail: `knowledge ${event} of "${name}" succeeded but its record could not be committed`,
                        context: { event, name },
                        cause,
                    })
                })
        },
    })

    /**
     * One block or many (concurrent, Promise.all-shaped) — always resolves.
     *
     * `origin` marks who asked. It defaults to the agent's own reasoning and
     * is only ever set by a developer-facing caller (Fleet's capsule input),
     * which changes nothing about how the code executes — same path, same
     * policy gate — and everything about how the session log reads it back.
     */
    function run(code: string, runOpts?: RunOptions): Promise<AxonRunResult>
    function run(code: string[], runOpts?: RunOptions): Promise<AxonRunResult[]>
    function run(code: string | string[], runOpts?: RunOptions): Promise<AxonRunResult> | Promise<AxonRunResult[]> {
        if (Array.isArray(code)) return Promise.all(code.map(c => runOne(capsule, c, runOpts)))
        return runOne(capsule, code, runOpts)
    }

    /**
     * The ABI's own run() — same normalized result as the script-facing
     * run() above, plus one more step: durably commits cognet:action:typescript
     * (the code) and cognet:action:result (the outcome) to the session's one log,
     * the moment each block settles. This is the platform-owned half of
     * the two-verb rule — the cognet never calls session.commit itself; it
     * just reads the returned result for its own control flow.
     */
    /**
     * A batch of blocks from one turn — concurrent, as it has always been.
     *
     * Concurrency is deliberate (see `run` on the capsule surface and zero's
     * own comment): the kernel commits each action and its result in order
     * regardless of the order the work finishes in, so running them together
     * is safe and much faster than a queue.
     *
     * What changes under cancellation is only WHETHER a script starts. Each
     * `runAndCommit` re-checks the signal, so a batch interrupted partway
     * commits the blocks that had already begun and skips the rest, instead of
     * executing all of them because they were all dispatched in one tick.
     *
     * `allSettled`, not `all`: a skipped script rejects, and one rejection must
     * not discard the results of siblings that genuinely ran. The results keep
     * their positions so a caller reading `results[i]` still gets block `i`.
     */
    async function runBatch(code: string[], signal: AbortSignal): Promise<AxonRunResult[]> {
        const settled = await Promise.allSettled(code.map(c => runAndCommit(c, { signal })))
        return settled.map(outcome => outcome.status === "fulfilled"
            ? outcome.value
            : interruptedResult(outcome.reason))
    }

    async function runAndCommit(code: string, runOpts?: { signal?: AbortSignal }): Promise<AxonRunResult> {
        const run = scheduler.active() // throws SYSCALL_OUTSIDE_RUN if no wake is running

        // A script that has not STARTED must not start once the wake is
        // cancelled. This is the boundary the kernel actually controls: the
        // capsule can kill a spawned process (procs.ts kills the tree on
        // abort), but a tool already inside `await` is only cancellable if it
        // threads the signal itself — which is not a contract we put on module
        // authors. So the kernel stops the SEQUENCE instead.
        //
        // The case this exists for is a turn that emitted several blocks: they
        // run as a batch (see `run` below), and without this check every
        // remaining script still executed after the user pressed Escape. One
        // long command was already killed; forty small writes were not.
        //
        // Checked here rather than in `run` so it covers both entry points,
        // and BEFORE the action is committed — a script that never ran must
        // not appear in the log as one that did.
        if (runOpts?.signal?.aborted) throw interruptedError(runOpts.signal)

        const id = Bun.randomUUIDv7()
        await session.commitEntry("cognet:action:typescript", { id, content: code }, run)
        // The entry id IS the capsule command id — one id for one execution,
        // so capsule:cmd/fn/activity spans join the visible tool call directly.
        const result = await runOne(capsule, code, { ...runOpts, id })
        await session.commitEntry("cognet:action:result", {
            for: id,
            ok: result.ok,
            content: capResult(
                [...result.stdout, result.ok ? formatValue(result.value) : ""].filter(s => s.length > 0).join("\n"),
            ),
            ...(result.error ? { error: result.error } : {}),
        }, run)
        return result
    }

    /**
     * The engine stream, with format violations recorded as system facts.
     *
     * A violation is the KERNEL's observation, not the cognet's speech: the
     * AIR parser detected it, and a cognet paraphrasing it through output()
     * would put runtime diagnostics in the agent's own voice — indistinguishable
     * from something the agent said, both to a reader and to the next render.
     * Committing it here as axon:system:message keeps the provenance honest,
     * renders it dimmed rather than as a message, and still puts it in front of
     * the model next tick (AIR renders <system>), which is what makes the
     * self-correction loop work.
     *
     * The event still reaches the cognet — a loop may want to react — but it
     * no longer has to launder it to make it visible.
     */
    /**
     * Record one format violation as a system fact.
     *
     * The single writer for both sources — the parser's own detections
     * (an unclosed block) and a cognet's via fault() (an interpolation
     * naming a binding that was never declared). One shape, one entry type,
     * one thing for a host to recognise and hide.
     */
    async function recordFault(
        fault: { code: string; message: string; excerpt?: string; rejected?: string; attempt?: number },
        run: { runId: string } | undefined,
    ): Promise<unknown> {
        // The rejected reply first, so the timeline reads in the order it
        // happened: the model spoke, then it was corrected. Committed as its
        // own entry rather than folded into the message because it is the
        // agent's own output, not the runtime's commentary on it — and a
        // reader that hides system messages must still see what was said.
        if (fault.rejected !== undefined && fault.rejected.trim().length > 0) {
            await session.commitEntry("axon:system:malformed", {
                content: fault.rejected,
                code: fault.code,
                attempt: fault.attempt ?? 1,
            }, run)
        }

        // MARKDOWN, and the code as an attribute rather than a prefix.
        //
        // These messages are written as markdown — headings, fenced examples,
        // backticked tags — and labelling them `txt` asks the model to read
        // structure it was told not to expect. The code was also prepended
        // inline, which put `OUTPUT_EMPTY: ` in front of a `##` heading and
        // broke the first line of every one of them.
        return session.commitEntry("axon:system:message", {
            type: "format-violation",
            lang: "md",
            content: fault.message,
            attributes: { code: fault.code, ...(fault.excerpt ? { excerpt: fault.excerpt } : {}) },
        }, run)
    }

    /**
     * The cognet's engine calls, with the invocation's output contract folded
     * in.
     *
     * A caller that declared `output` on request() demanded a shape of THIS
     * invocation, and the engine is what enforces it — so the contract is
     * attached here rather than passed through cognition, which has no
     * business knowing a shape was asked for. A cognet renders context and
     * reads facts; it never carries the caller's requirements.
     */
    /**
     * The ABI's inference surface — a role name in, a handle out.
     *
     * Callable with `has` attached, so using an engine reads as one verb and
     * checking for one reads as a question. Every handle routes through the
     * same recording path, so a percept call is as traced as a cortex call —
     * an untraced second model would be exactly the observability hole this
     * whole layer is supposed to close.
     */
    const engineAbi = Object.assign(
        (role: string) => {
            const bound = opts.engines?.resolution.bound.find(entry => entry.role === role)
            if (!bound) {
                throw err("ENGINE_ROLE_UNBOUND", {
                    detail: `no engine bound to "${role}" — declare it in engines: and check kernel.engine.has() for optional roles`,
                })
            }

            // What the role ACTUALLY got, shared by every handle shape.
            const facts = {
                get context() { return bound.capability.context },
                get modalities() { return { in: bound.capability.in, out: bound.capability.out } },
                get slots() { return bound.slots },
            }

            // The handle follows the DECLARED type, because that is what the
            // cognet's code was written against: a loop calling `.transform()`
            // cannot run against a `.stream()` handle however substitutable
            // the model behind it is. Resolution already refused anything
            // whose type disagrees, so this never has to reconcile them.
            if (bound.requirement.type === "transform") {
                return {
                    ...facts,
                    type: "transform" as const,
                    transform: (input: unknown, transformOpts?: TransformOptions) =>
                        transformAndRecord(role, input, transformOpts),
                }
            }

            if (bound.requirement.type === "stream") {
                return {
                    ...facts,
                    type: "stream" as const,
                    open: () => openSession(role),
                }
            }

            return {
                ...facts,
                type: "generate" as const,
                stream: (req: AxonEngineCall) => streamAndRecord({ ...req, role }),
                async request(req: AxonEngineCall) {
                    for await (const event of streamAndRecord({ ...req, role })) {
                        if (event.type === "engine:done") return event.response
                    }
                    throw err("ENGINE_NO_DONE")
                },
            }
        },
        {
            has: (role: string): boolean =>
                opts.engines?.resolution.bound.some(entry => entry.role === role) ?? false,
        },
    )

    /**
     * The driver bound to a role, narrowed to the kind the role declared.
     *
     * Resolution already matched the declared type against the capability, so
     * a mismatch here means a provider's create() disagreed with the
     * capability it was handed — a wiring fault, and loud rather than coerced.
     */
    function driverFor<K extends "transform" | "stream">(role: string, kind: K) {
        const bound = opts.engines?.resolution.bound.find(entry => entry.role === role)
        const driver = opts.engines?.get(role).driver
        if (!driver || driver.kind !== kind) {
            throw err("ENGINE_ROLE_UNBOUND", {
                detail: `role "${role}" is not bound to a ${kind} engine`,
                context: { role, kind, ...(bound ? { provider: bound.capability.provider } : {}) },
            })
        }
        return { driver: driver as Extract<AxonDriver, { kind: K }>, bound }
    }

    /**
     * One transform call, bracketed with the same span family a generate call
     * uses.
     *
     * Traced for the reason every mediated resource is: an untraced second
     * engine is exactly the observability hole this whole layer was supposed
     * to close. A depth estimation that takes four seconds must be as visible
     * in the flame graph as a model call that takes four seconds.
     *
     * The PAYLOAD is never logged — it is a tensor, an image, a waveform, and
     * the log is a record of what happened rather than a copy of what moved.
     */
    async function transformAndRecord(role: string, input: unknown, transformOpts?: TransformOptions): Promise<unknown> {
        const run = scheduler.active()
        const { driver, bound } = driverFor(role, "transform")
        const span = { runId: run.runId, spanId: Bun.randomUUIDv7() }
        const started = Date.now()

        const correlation = {
            role,
            provider: bound?.capability.provider ?? "unknown",
            ...(bound?.capability.id ? { model: bound.capability.id } : {}),
        }
        await session.commit("kernel:transform:start", correlation, span)

        try {
            const result = await driver.transform(input, transformOpts)
            await session.commit("kernel:transform:complete", { role, durationMs: Date.now() - started }, span)
            return result
        } catch (cause) {
            const failure = err(cause)
            await session.commit("kernel:transform:failed", {
                role,
                fault: asEngineFault(cause, { provider: correlation.provider }),
                durationMs: Date.now() - started,
            }, span)
            throw failure
        }
    }

    /**
     * Open one session on a stateful engine.
     *
     * Deliberately NOT traced per push: a VAD at 30Hz is 1800 pushes a
     * minute, and committing a span for each would drown the log the way
     * nothing else in this system does. The open and close are the events
     * worth having — they bracket the resource's lifetime, which is the thing
     * a reader actually wants to see.
     */
    function openSession(role: string): EngineSession {
        const { driver, bound } = driverFor(role, "stream")
        const inner = driver.open()

        const span = { runId: scheduler.active().runId, spanId: Bun.randomUUIDv7() }
        const opened = Date.now()
        void session.commit("kernel:transform:start", {
            role,
            provider: bound?.capability.provider ?? "unknown",
            ...(bound?.capability.id ? { model: bound.capability.id } : {}),
        }, span)

        return {
            push: input => inner.push(input),
            reset: () => inner.reset(),
            close: () => {
                inner.close()
                void session.commit("kernel:transform:complete", { role, durationMs: Date.now() - opened }, span)
            },
        }
    }

    async function* streamAndRecord(req: Parameters<typeof engine.stream>[0]): AsyncGenerator<AxonEngineEvent> {
        const run = scheduler.active()
        // The wake's cancellation is applied here, not passed in: an
        // inference call is a mediated resource like the capsule, and a
        // program that forgot to thread a signal made one unkillable.
        const call = { ...req, ...activeContract, signal: run.signal }

        for await (const event of engine.stream(call, run)) {
            // A call that could not produce a usable response THROWS rather
            // than arriving as an event a cognet might ignore. Yielding it
            // and trusting every loop to check would make "the model never
            // satisfied its contract" look identical to a completed wake —
            // exactly the silent degradation the caller asked for a shape to
            // avoid. The event is still yielded first so a consumer watching
            // the stream sees the cause before the throw.
            if (event.type === "engine:failure") {
                yield event
                throw event.error
            }

            // The turn the model declared over, written down.
            //
            // `<done/>` was parsed as a signal and dropped, so it was the one
            // block absent from the model's own record: it read the rule every
            // call and never once saw itself having followed it. Committing it
            // puts the turn boundary in the history the model reads back, which
            // is where every other block already earns its reinforcement.
            //
            // Committed HERE rather than by the cognet: a cognet reads
            // `yielded` to decide whether to keep looping, which is a
            // cognition decision. Writing the fact down is the kernel's, the
            // same as every other entry.
            if (event.type === "engine:done" && event.yielded) {
                await session.commitEntry("axon:agent:done", {}, run)
            }

            yield event
        }
    }

    /**
     * The output contract for the wake currently running, if any.
     *
     * Wake-scoped, not kernel-scoped: it belongs to ONE invocation, and a
     * value that outlived its wake would silently impose the previous
     * caller's shape on the next request. Never reaches the ABI — the cognet
     * has no idea a shape was demanded, which is the whole point.
     */
    let activeContract: { output: NonNullable<KernelInput["output"]>; retries?: number } | null = null

    /**
     * One wake, with its output contract live for exactly the wire's
     * lifetime.
     *
     * Both public verbs route through here — `request()` is `stream()`
     * drained — so a contract can never be installed for one and skipped for
     * the other. Wrapping the wire rather than setting the contract beside
     * the call makes teardown total: a normal end, a throw, an interrupt, or
     * a consumer that abandons the stream all run the generator's finally.
     */
    function streamWithContract(input: KernelInput = {}) {
        const run = scheduler.stream(input)
        if (!input.output) return run

        activeContract = {
            output: input.output,
            ...(input.retries === undefined ? {} : { retries: input.retries }),
        }
        const inner = run.stream
        return {
            ...run,
            stream: (async function* () {
                try {
                    yield* inner
                } finally {
                    activeContract = null
                }
            })(),
        }
    }

    // ── the ABI — the syscall table, bound once to the kernel's organs ──────
    // Process-lifetime object: nothing on it carries per-wake state beyond
    // what scheduler.active() resolves internally. This is the only thing
    // a program ever holds.
    const abi: KernelAbi = {
        /** unmediated — commits directly to the session's one log, never refuses */
        output: (type, data) => {
            const run = scheduler.active() // throws SYSCALL_OUTSIDE_RUN if no wake is running
            // AxonEntryEvent is an intersection that CONTAINS AxonOutputEvent,
            // so for any output key the two payload types are the same type —
            // TS can't prove it through the intersection for a generic K. The
            // TYPE is now fully checked (it was `as never` before, checking
            // nothing); only the payload's provenance needs asserting, and
            // it's asserted at this one key, not across the union.
            return session.commitEntry(type, data as AxonEntryEvent[typeof type], run).then(() => {})
        },

        // llm surface — by role, resolved at boot against the user's providers
        engine: engineAbi,

        /**
         * A format violation the COGNET detected while rendering the model's
         * output — the kernel writes the system fact the cognet may not forge.
         */
        fault: (input) => recordFault(input, scheduler.active()).then(() => {}),

        /**
         * capsule surface — self-committing (see runAndCommit above).
         *
         * The wake's cancellation is applied HERE, resolved from the run this
         * syscall belongs to. A program never passes a signal and so can
         * never omit one: a kill is authoritative, not something cognition
         * opts into per call.
         */
        run: ((code: string | string[]) => {
            const { signal } = scheduler.active() // throws SYSCALL_OUTSIDE_RUN if no wake is running
            if (Array.isArray(code)) return runBatch(code, signal)
            return runAndCommit(code, { signal })
        }) as KernelAbi["run"],
        scope: () => capsule.current.scope,


        // environment surface
        base: opts.base,

        /**
         * Cognet telemetry — enforced at the call site, not just the type:
         * the cognet's own `emit<K extends keyof CognetEventMap>` signature
         * already prevents a well-typed call from naming anything outside
         * cognet:*, but nothing stopped a raw/untyped call from reaching the
         * write path under any string. Refusing loudly here closes that gap —
         * a cognet can narrate its own world, never forge kernel machinery.
         *
         * Durable: commits to the session's log (which forwards to the bus
         * after the append lands), same pipeline as every other event — the
         * cognet's telemetry is debugging record, and a log it never reaches
         * is a log that can't debug it. Fire-and-forget for the cognet
         * (emit stays sync/void); a continuous-mode cognet ticking fast will
         * make this chatty — the known cost, gate at the write if it bites.
         */
        emit: (type, data) => {
            if (!(type as string).startsWith(COGNET_EVENT_PREFIX)) {
                throw err("COGNET_EMIT_FORBIDDEN", { detail: `cognet may only emit cognet:* events, got "${type as string}"`, context: { type: type as string } })
            }
            // runId when a wake is running, bare outside one (load/unload
            // narration is legal) — current() never throws, unlike active().
            //
            // The catch is required, not defensive: emit() is sync by
            // contract (the cognet never awaits its own telemetry), so a
            // rejected commit has nowhere to go. Without it a disk failure
            // during a fast-ticking wake would surface as an unhandled
            // rejection and kill the runtime — a telemetry write must never
            // be able to take down the thing it is observing.
            void session
                .commit(type, data as AxonEventMap[typeof type], scheduler.current() ?? undefined)
                .catch(() => {})
        },

        // persistence surface — private cognitive state + read-only episodic
        // access, one mediated door like stream/run (see Store())
        store: store,

        // long-term knowledge — the durable, human-readable counterpart to
        // store's private kv. Same mediation (a name in, the kernel owns the
        // path), different doctrine: this is the record, not a cache.
        knowledge: knowledge,

        // The brain's own rhythm. Called from a cognet plugin, never from the
        // body — see KernelAbi.wake for why the body must not drive this.
        // Deliberately NOT awaited into the wake: admission is the contract,
        // so a driver on an interval never serialises the overlap.
        wake: () => scheduler.wake(),

        clock: () => scheduler.clock(),

        // Resolved at prepare and carried on the blueprint — the runtime only
        // hands the paths over. Frozen so a brain cannot mutate the map it
        // was given, and empty (never undefined) so a cognet reads it without
        // branching.
    }

    // exec(): the kernel is the only loader. ABI compatibility is checked
    // inside the handle; a mismatched artifact never half-loads.
    //
    // The kernel owns this bracket rather than the cognet: exec'ing an
    // untrusted artifact is boot's most failure-prone step, and a brain that
    // dies inside load() could never close a bracket it opened itself.
    const loadStarted = Date.now()
    await session.commit("cognet:load:start", { name: cognet.name })
    try {
        await cognet.load(abi)
    } catch (cause) {
        const failure = err(cause)
        await session.commit("cognet:load:failed", { name: cognet.name, error: failure, durationMs: Date.now() - loadStarted })
        throw failure
    }
    await session.commit("cognet:load:complete", { name: cognet.name, durationMs: Date.now() - loadStarted })
    scheduler.attach(cognet)

    return {
        /**
         * Whether a cognet is loaded and able to wake.
         *
         * False after a failed load or a reload whose new brain did not
         * compile: the process is alive and serving HTTP, but there is
         * nothing to think with. An agent in that state must not report
         * itself healthy — it looks fine from outside while silently
         * answering nothing.
         */
        get ready() {
            return scheduler.loaded
        },

        /**
         * The capsule's executable scope, as the ABI reports it to a cognet.
         *
         * On the public surface because an output type is typechecked
         * against it: a caller declaring `{ files: FileEntry[] }` may name a
         * type the agent's own tools declare, and checking against anything
         * other than the scope the MODEL is shown would accept types the
         * model cannot see or reject ones it can.
         */
        scope: () => capsule.current.scope,

        /**
         * How this agent's declared engine roles resolved, and what can be
         * rebound.
         *
         * On the HOST surface, not the cognet's: a model picker has to render
         * which role holds which model and point one somewhere else, and a
         * brain must never see either — the whole indirection exists so
         * cognition cannot learn what is behind a role. Undefined for an
         * agent whose cognet declared none.
         */
        get engines() {
            return opts.engines
        },

        /** Invoke on a stimulus arrival — invocation-mode cognets only; throws for continuous-mode. */
        stream: streamWithContract,

        /**
         * Collect a full wake: every durable entry, in commit order.
         *
         * Goes through THIS handle's stream(), not the scheduler's, so an
         * output contract is installed and torn down identically for both
         * verbs — reaching past it would have made `request({ contract })`
         * silently unenforced.
         */
        async request(input: KernelInput = {}): Promise<{ ok: true; entries: AxonEntry[] }> {
            const entries: AxonEntry[] = []
            for await (const entry of streamWithContract(input).stream) {
                entries.push(entry) // the wire carries entries, full stop — chunks included
            }
            return { ok: true, entries }
        },

        // No tick() on the public surface. The brain drives its own rhythm
        // through the ABI (KernelAbi.tick, called from a cognet plugin) —
        // exposing it here would let the body wake a mind it knows nothing
        // about, which is the coupling this split exists to remove.

        /** Abort the active wake, if any. Safe to call when idle. */
        interrupt(reason: "user" | "shutdown" = "user") {
            scheduler.interrupt(reason)
        },

        /**
         * Execute code in the capsule directly — the same conversation an
         * agent-generated <typescript> block gets, mediated by the same
         * policy and the same normalized result. Backs axon.tools.* proxy
         * calls from script-land; the kernel is the only capsule
         * constructor, so callers reach it here, never by holding the
         * capsule handle themselves.
         */
        run,

        /**
         * The capsule's process tree, live: `main` is the sandboxed TS
         * runtime itself, `processes` its managed children (everything the
         * agent has spawned). Read/observe surface for clients (the TUI's
         * capsule tree); the kernel remains the only constructor.
         */
        get userland() {
            return {
                main: capsule.current.main,
                processes: capsule.current.process.list(),
            }
        },

        /**
         * The agent changed: one entry point, fanned out to the organs.
         * Receives the full re-normalized blueprint from the runtime.
         */
        async update(next: AxonBlueprint) {
            engine.update(next)
            opts.onUpdate?.(next)
            await cognet.update(next)
            await capsule.update(next) // new policy → rebuilt sandbox, live before old drops
        },

        /**
         * Drain the mind: abort any wake, unload the brain, kill the
         * userland. Session is not kernel's to close — AxonRuntime.shutdown()
         * ends it after this resolves, so a failure here never skips flushing
         * the log.
         *
         * THE BRAIN STOPS ITS OWN CLOCK, AND IT MUST STILL HAVE A KERNEL WHEN
         * IT DOES. A continuous cognet is ticked by one of its own plugins
         * driving kernel.wake() on an interval, and that interval is cleared
         * by the plugin's own "shutdown" hook — which runs inside
         * cognet.unload(). So unload() has to complete BEFORE anything the
         * clock touches is torn down.
         *
         * This used to call scheduler.detach() first, on the reasoning that a
         * brain being torn down can no longer wake. True, but it made wake()
         * throw NO_COGNET_LOADED while a 30Hz interval was still firing into
         * it — an unhandled rejection every ~33ms of teardown, from a plugin
         * doing exactly what the authoring surface tells it to. Detaching
         * after unload closes that window without weakening the guard: the
         * clock is already stopped by then, so nothing is left to wake.
         */
        async shutdown() {
            scheduler.interrupt("shutdown")

            // A failed unload must never strand the userland: the capsule is
            // a real OS process, and skipping its teardown leaks it for the
            // life of the host. The brain's failure is recorded, then
            // rethrown after the box is definitely gone.
            const unloadStarted = Date.now()
            await session.commit("cognet:unload:start", { name: cognet.name })
            let failure: ReturnType<typeof err> | null = null
            try {
                await cognet.unload()
                await session.commit("cognet:unload:complete", { name: cognet.name, durationMs: Date.now() - unloadStarted })
            } catch (cause) {
                failure = err(cause)
                await session.commit("cognet:unload:failed", { name: cognet.name, error: failure, durationMs: Date.now() - unloadStarted })
            }
            // After the unload, whether it succeeded or threw: readiness must
            // stop claiming a brain that is gone, and a cognet whose unload
            // failed is no more wakeable than one whose unload worked.
            scheduler.detach()
            // Drop the stimulus subscription too — detach() stops wakes, but
            // the bus would otherwise hold this scheduler alive for the life
            // of the process, and a host running several agents in sequence
            // accumulates one dead listener per shutdown.
            scheduler.dispose()

            await capsule.shutdown()
            if (failure) throw failure
        },
    }
}

export type AxonKernelT = Awaited<ReturnType<typeof Kernel>>
