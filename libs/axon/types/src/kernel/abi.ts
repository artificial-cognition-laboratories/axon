import type { AxonEngineCall, AxonEngineResponse } from "../engine"
import type { AxonEngineEvent } from "../session/events/engine"
import type { AxonEntry } from "../session/session"
import type { AxonOutputEvent } from "../session/events/stdio/output"
import type { AxonStimulusEntry } from "../session/events/stdio/stimuli"
import type { CognetEventMap } from "../session/events/cognet"
import type { AxonScope } from "../scope"
import type { Modality } from "../inference"
import type { CapsuleScope } from "../capsule-scope"

/**
 * The current kernel ABI contract version. Program definitions declare the
 * version they were built against; the kernel refuses loudly on mismatch.
 * Bump on any breaking change to KernelAbi or CognetWake — reluctantly,
 * like the syscall table it is.
 *
 * THE VERSIONED SURFACE IS MORE THAN THE FUNCTION SHAPES. A cognet is a
 * prebuilt bundle: it compiled against a snapshot of every payload type
 * this file references — AxonOutputEvent (output), AxonEngineCall /
 * AxonEngineEvent (stream), CognetEventMap (emit), AxonEntry
 * (the wake wire). A breaking change to ANY of those is a breaking change to the
 * ABI and requires a version bump, even though no signature here moved —
 * otherwise a stale bundle loads cleanly under a matching version number
 * and misreads events at runtime. Nothing enforces this mechanically yet;
 * the rule is the enforcement. (Additive changes — new event types, new
 * optional fields — are compatible, like new syscalls.)
 */
export const KERNEL_ABI_VERSION = "11"

/**
 * The cognet's own store schema — EMPTY here by design. A cognet declares
 * its keys/values once via declaration merging (the same pattern Nuxt uses
 * for runtime config, Vue for ComponentCustomProperties):
 *
 *   // anywhere in the cognet's own sources
 *   declare global {
 *       interface CognetStoreSchema {
 *           checkpoint: { entries: unknown[]; seq: number }
 *       }
 *   }
 *
 * kernel.store.get/set are typed against keyof this interface, so a cognet
 * with no declaration has no callable kv (keyof {} is never) — declaring
 * the schema IS opting in. Each bundle compiles against its own
 * augmentation; nothing leaks between cognets.
 *
 * Declared GLOBAL (not module-scoped) deliberately: a cognet augments it
 * with a plain `declare global` block — module augmentation would force
 * every author to name this package's specifier, which is exactly the
 * kind of plumbing the ambient-globals authoring surface exists to hide.
 */
declare global {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface CognetStoreSchema {}
}

/**
 * Private cognitive state + the episodic record, one door (kernel.store).
 *
 * Two rooms with two ownership regimes, deliberately asymmetric:
 * - `session` — the session's entry log, READ-ONLY. This is how a cognet
 *   reaches its own history (cold-boot rehydration, context rebuilds)
 *   without the runtime passing anything in at boot. Entries only — never
 *   kernel telemetry, never error machinery. There is no write verb here
 *   and never will be: the cognet's only writes to the world are
 *   kernel.output()/kernel.run(); a patchable record is a footgun by
 *   construction.
 * - the kv — the cognet's private consolidated state. One flat namespace
 *   per cognet (keyed by cognet name on disk); the kernel imposes NO
 *   lifetime taxonomy — a cognet that wants session-scoped keys prefixes
 *   with the sessionId it already has from every entry's envelope.
 *   Doctrine: this is a CACHE over the log. Atomic per key,
 *   last-write-wins (it's the one writable surface concurrent instances
 *   of the same agent share), unreadable/stale state is discarded and
 *   rebuilt from `session` — deleting data/state/ is always safe.
 */
export type KernelStore = {
    session: {
        /**
         * The session's entries so far, in seq order — the same envelopes
         * stimuli arrive as. `after` is a seq cursor: boot reads all and
         * remembers its high-water mark; steady-state never re-reads
         * history it already folded. Synchronous — this is the kernel's
         * live in-memory projection, not a disk read.
         */
        get(opts?: { after?: number }): readonly AxonEntry[]
    }

    /** Read one key. Null when absent (or unreadable — cache doctrine: rebuild, don't crash). */
    get<K extends keyof CognetStoreSchema>(key: K): Promise<CognetStoreSchema[K] | null>

    /** Write one key. Atomic (temp+rename); resolves when durable. */
    set<K extends keyof CognetStoreSchema>(key: K, value: CognetStoreSchema[K]): Promise<void>
}

/**
 * One catalogued item in the knowledge store.
 *
 * A NAME, never a path. The cognet addresses knowledge by a stable
 * identifier the author chose; where that lands on this machine is the
 * kernel's business and must stay invisible — the same rule `models`
 * states, for the same reason (a path is environmental, and a brain that
 * learned one stops being portable to a body that stores things
 * differently).
 *
 * `description` is author-supplied metadata, empty string when none —
 * never undefined, so a renderer never branches. It exists because the
 * catalogue's whole job is being cheap enough to hold ambiently: an LLM
 * brain renders name + description for everything it has and reads only
 * what the task needs. A brain that already knows its names ignores all
 * of it and calls read() directly, the way a controller ignores stream().
 */
export type KnowledgeEntry = {
    /** Stable identifier. Namespaced for module material, so two corpora cannot collide. */
    name: string
    /** Author-supplied summary. Empty when the entry declares none — never undefined. */
    description: string
    /** Bytes on disk — lets a cognet decide whether to read before it does. */
    size: number
    /**
     * Absolute path to the file.
     *
     * Present because knowledge is no longer one directory: a module's corpus
     * lives inside its own package, so a name cannot be joined to a root the
     * way `AXON_HOME/data/knowledge/<name>` once could. A cognet that wants
     * the model to open a file with ordinary fs tools has to render something
     * openable, and the alternative — teaching the model two path rules and
     * which entries follow which — is worse than handing it the answer.
     *
     * This is the same call `models` already makes: the kernel resolves, the
     * brain receives. What a cognet must not do is DERIVE a path from a
     * layout it assumed; reading one it was given is ordinary.
     */
    path: string
}

/**
 * The knowledge store — durable, human-readable, human-editable material
 * the brain consults and maintains. The long-term counterpart to
 * `store`'s private kv.
 *
 * Three things distinguish it from every other durable surface:
 *
 * - It is INPUT, not output. A session log records what the agent did; a
 *   knowledge entry is what someone (a human, a module, or the brain
 *   itself) decided is worth keeping. That is why it lives outside
 *   .agent/ and is published with the agent.
 * - It is NOT a cache. Unlike `store`, losing it is real data loss, so
 *   writes are atomic and a missing entry throws rather than returning
 *   null. If a brain was told an entry exists and it does not, something
 *   is wrong and silence would hide it.
 * - It is FORMAT-AGNOSTIC by refusal. The kernel hands over bytes and a
 *   name; what those bytes mean is the cognet's business, exactly as the
 *   weights behind `models` are. Markdown, JSON, CSV, a serialized graph —
 *   the store has no opinion and will never grow one.
 *
 * RETRIEVAL IS COGNITION AND LIVES IN THE COGNET. There is no semantic
 * search, no ranking, no embedding here and there must never be: choosing
 * how a mind recalls is a memory policy, which the kernel is forbidden
 * from holding (see the design rules on KernelAbi). `list`'s `match` is a
 * substring filter over catalogue metadata the caller supplies — the
 * kernel executes a predicate it is given, it never supplies one. A brain
 * that wants full-text search greps through run(); a brain that wants
 * embeddings builds them and keeps the index in `store`, where derived
 * state belongs.
 *
 * Writes are confined to the store root and enforced, not trusted — a
 * name that resolves outside it throws. The cognet gains one more mediated
 * door, never a filesystem.
 */
export type KernelKnowledge = {
    /**
     * The catalogue — every entry, name and description only, never content.
     *
     * Ordered by `name`, bytewise ascending. STATED rather than left to the
     * filesystem because an unspecified order is a ranking nobody declared
     * and every cognet silently inherits; a caller that wants a different
     * one sorts the result it was given.
     *
     * `match` is a case-insensitive substring test against name and
     * description. `limit` truncates AFTER ordering, so a capped render is
     * a stable prefix rather than an arbitrary sample.
     */
    list(opts?: { match?: string; limit?: number }): Promise<readonly KnowledgeEntry[]>

    /**
     * Read one entry's content, as UTF-8 text.
     *
     * Throws KNOWLEDGE_NOT_FOUND when absent. Deliberately not null-on-
     * missing: this is not a cache, and a brain reading something the
     * catalogue advertised has hit a real inconsistency that must be loud.
     */
    read(name: string): Promise<string>

    /**
     * Write one entry, creating or replacing it. Atomic (temp + rename) —
     * a kill mid-write leaves the previous content, never a torn file,
     * because unlike `store` this cannot be silently rebuilt.
     *
     * Parent directories are created as needed, so a brain organising its
     * own memory into folders needs no separate verb for it.
     */
    write(name: string, content: string): Promise<void>

    /**
     * Delete one entry. A no-op when already absent — removal is
     * idempotent, and a brain pruning its own memory should not have to
     * check first.
     */
    remove(name: string): Promise<void>
}

/**
 * The outcome of one capsule run — success and failure are both ordinary
 * values here, never a rejection. `stdout` is every console.* call this
 * specific block made, in order, already joined into lines by the kernel —
 * a program that wants it folded into a committed result just reads it,
 * it never wires a console callback to build it itself.
 */
export type AxonRunResult = {
    ok: boolean
    /** The block's completion value when ok. Undefined on failure. */
    value?: unknown
    /** console.* output from this block, in order, one entry per call. */
    stdout: string[]
    /**
     * The top-level bindings this block declared — what a template rendered
     * from the same turn interpolates against. Empty on failure, and empty
     * for a block that declared nothing; never absent, so a caller never has
     * to distinguish "no scope" from "scope unavailable".
     */
    scope: CapsuleScope
    error?: { kind: "timeout" | "interrupt" | "exception"; message: string }
}

/**
 * The kernel ABI — the syscall table. Everything a program may touch.
 *
 * Hand-written contract (cross-package seam): programs are versioned
 * against this exactly like binaries against syscalls — the kernel evolves
 * freely as long as this shape holds.
 *
 * Design rules:
 * - There is no thread/session concept on this ABI at all. One cognet
 *   instance is always exactly one continuous stream — a program never
 *   addresses anything by id, the same way it never passes a session
 *   handle. Multiple independent conversations are multiple Axon()
 *   instances, a host-level (TUI) concern this ABI has no opinion on.
 *   A cognet's entire vocabulary for touching the world is exactly two
 *   verbs, output() and run(), both committed by the kernel on the
 *   cognet's behalf. It never reads or writes the log directly.
 * - output() vs run() is the one distinction that matters here: output() is
 *   a self-contained emission — the cognet already has the full content,
 *   nothing external can fail it, so it's unmediated at the call site
 *   (writing to your own stdout can't itself harm anything). run() is a
 *   mediated REQUEST — the cognet doesn't know the outcome until the
 *   capsule responds, so it's policy-gated and never rejects, returning a
 *   stable result the cognet reads to decide what to do next.
 * - The kernel has NO opinion on cognition: no grammar, no context assembly.
 *   It guards the user's base identity and reports the capsule's executable
 *   scope; the program alone decides how either enters model context.
 */
/**
 * What a cognet may ask of an engine.
 *
 * AxonEngineCall minus the fields the KERNEL owns. `signal` is the wake's
 * cancellation, applied by the kernel unconditionally — a program never
 * passes one and so can never omit one. `output`/`retries` are the caller's
 * structured-output contract, attached from the invocation; a cognet has no
 * business knowing a shape was demanded.
 */
export type CognetEngineCall = Omit<AxonEngineCall, "signal" | "output" | "retries">

/**
 * One bound role, as the cognet holds it.
 *
 * A HANDLE, not a driver: what fills a role can be swapped while the agent
 * runs (a user picks a different model), and a cognet holding the inner
 * thing would be stranded by that. Calls dispatch through the manager, so a
 * rebind is invisible here.
 *
 * `context` and `modalities` report what the role ACTUALLY got, which is how
 * a brain that declared a floor decides how hard to push against it. `slots`
 * is the concurrency granted: 1 on a laptop, more on a hosted route, never
 * zero — a fanned-out role always degrades to sequential rather than absent.
 */
export type KernelEngine = GenerateEngine | TransformEngine | StreamEngine

/** What every engine handle reports about what it actually got. */
type EngineFacts = {
    /** Usable context window of the bound model. Undefined when the source does not report one. */
    readonly context: number | undefined
    /** What the bound model accepts and produces. */
    readonly modalities: { in: readonly Modality[]; out: readonly Modality[] }
    /** Concurrent calls this role may run. At least 1. */
    readonly slots: number
}

/**
 * Autoregressive generation over MESSAGES — the AIR protocol.
 *
 * `generate` is defined by its call shape, not by whether the model happens
 * to sample autoregressively: a handle here takes a conversation and yields
 * parsed blocks. That is why text-to-speech is a `transform` even though the
 * model behind it generates token by token — it takes a string, not a
 * timeline, and nothing about the grammar applies.
 */
export type GenerateEngine = EngineFacts & {
    readonly type: "generate"
    /** Stream block events in real time, terminated by a single engine:done. */
    stream(req: CognetEngineCall): AsyncGenerator<AxonEngineEvent>
    /** Single-shot completion. Same response shape as the stream's done event. */
    request(req: CognetEngineCall): Promise<AxonEngineResponse>
}

/**
 * One shot in, one shot out — ASR, embeddings, classifiers, depth, TTS.
 *
 * The kernel does NOT interpret either side. A depth map is a shaped array, a
 * transcript is text with timings, an embedding is a vector; what the bytes
 * MEAN is the cognet's business, exactly as the weights behind `models:` were.
 * The one thing this contract guarantees is that the call happened and the
 * result came back.
 *
 * `onProgress` exists because "one shot" is about SHAPE, not duration: an
 * image generation is thirty seconds of denoising steps, and a bare promise
 * makes that indistinguishable from a hang. Absent for the many transforms
 * that finish in milliseconds and report nothing.
 */
export type TransformEngine = EngineFacts & {
    readonly type: "transform"
    transform(input: unknown, opts?: TransformOptions): Promise<unknown>
}

export type TransformOptions = {
    /**
     * Progress for a long transform, when the binding reports any.
     *
     * `fraction` is 0..1 where the model knows its own total (denoising
     * steps); absent where it does not, so a caller renders a spinner rather
     * than a bar that lies.
     */
    onProgress?: (progress: { fraction?: number; message?: string }) => void
}

/**
 * A stateful sequential feed — VAD, streaming ASR, trackers.
 *
 * Distinct from `transform` because the model carries hidden state ACROSS
 * calls: Silero's LSTM is what lets it tell a pause mid-sentence from
 * silence, and feeding frames out of order or through two sessions destroys
 * exactly that. So a caller opens one session and pushes into it, rather than
 * making N independent calls.
 *
 * The session is the cognet's to hold — it is resident memory of precisely
 * the kind a brain keeps.
 */
export type StreamEngine = EngineFacts & {
    readonly type: "stream"
    /** Begin one sequence. Every push into it shares the model's hidden state. */
    open(): EngineSession
}

export type EngineSession = {
    /** Feed one item. Order is significant — that is what makes this not a transform. */
    push(input: unknown): Promise<unknown>
    /**
     * Forget the sequence so far, keeping the session.
     *
     * Every stateful model has some version of "this is a new utterance" —
     * reopening instead would rebuild the graph, which is the expensive part
     * and exactly what a session exists to amortise.
     */
    reset(): void
    /** Release the session. The engine stays loaded; only this sequence ends. */
    close(): void
}

/**
 * The cognet's whole inference vocabulary: name a role, get a handle.
 *
 * Callable, with `has` hanging off it, so the common case reads as one verb
 * (`kernel.engine("main")`) and the degradation check reads as a question
 * (`kernel.engine.has("percept")`).
 */
export type KernelEngines = {
    /**
     * The handle for a declared role.
     *
     * Throws for an unbound one. Deliberately loud: a REQUIRED role that
     * could not be filled already stopped the boot, so reaching here means a
     * cognet called an OPTIONAL engine without asking `has()` first — a
     * cognet bug, and a null handle would only move the crash one frame
     * later with less to say about it.
     */
    (role: string): KernelEngine

    /**
     * Is this role filled?
     *
     * The entire degradation contract. A cognet asks before using anything
     * it declared optional and takes a cheaper path when the answer is no —
     * which is what lets one brain run against a frontier account and
     * against a single local model without knowing which it got.
     */
    has(role: string): boolean
}

export type KernelAbi = {
    /**
     * Emit a fact to the world — text, audio, visual, or a declared field
     * reading. Unmediated: the kernel commits it durably to the session's
     * one log and forwards it live, but never refuses it — there is
     * nothing to refuse (see design rules above). Any redaction/filtering a
     * host wants happens downstream of the commit, on the delivery/render
     * path, never as a gate this call has to pass through.
     */
    output<K extends keyof AxonOutputEvent>(type: K, data: AxonOutputEvent[K]): Promise<void>

    /**
     * Inference, by ROLE — the names this cognet declared in `engines:`.
     *
     * ```ts
     * const main = kernel.engine("main")
     * for await (const event of main.stream({ messages })) { }
     * ```
     *
     * Replaces the old flat `stream()`, which could only ever reach one
     * model because an agent could only configure one. A cognet now names
     * what an engine is FOR and the kernel hands over whatever the user's
     * declared providers could fill it with — so a compression pass, a
     * critic and a cortex are three roles rather than three reasons to
     * couple a brain to a provider.
     *
     * The kernel still mediates every call (auth, metering, the grammar the
     * reply is parsed with); what it no longer decides is WHICH model, and
     * the cognet still never learns.
     */
    engine: KernelEngines

    /**
     * Execute code in the capsule — ring 3, policy-mediated. The only
     * syscall a tool call ever needs. Never rejects: success and failure are
     * both ordinary values on the returned result, not two different control
     * flows a program has to catch and re-discriminate (timeout vs abort vs
     * exception all collapse into one `error.kind`). Console output is
     * captured server-side and returned inline — no callback, because the
     * kernel already auto-wires the capsule's own event stream onto the bus
     * (untranslated, same as capsule:attach/detach); a program that wants to
     * fold stdout into its own committed result reads it off the result, it
     * never wires the plumbing itself. The kernel durably commits
     * cognet:action:typescript/cognet:action:result to the session's one log the
     * moment the capsule's own cmd:complete/cmd:failed lands — the same
     * pattern as capsule:attach/detach — never something cognet code writes.
     *
     * A single string runs one block; an array runs every block concurrently
     * (Promise.all-shaped) and returns results in the same order — the
     * common "await several tool calls to respond" case needs no manual
     * fan-out.
     */
    run(code: string): Promise<AxonRunResult>
    run(code: string[]): Promise<AxonRunResult[]>

    /**
     * The complete TypeScript scope implemented by the current capsule
     * incarnation. The kernel reports executable reality; the cognet decides
     * where and how that capability surface enters model context.
     */
    scope(): AxonScope


    /**
     * The agent's base context, rendered — boot.md / boot.vue. Kernel-
     * mediated because it's the USER's identity contract, not program
     * strategy: a swapped brain decides where the base context sits in its
     * rendering, never what it says. Empty string when the agent declares
     * none — never undefined; the seam normalizes so callers never branch.
     */
    base(): Promise<string>

    /**
     * Cognet telemetry — fire-and-forget for the cognet, durable in the
     * machine: committed to the session's log and forwarded to the runtime
     * bus, flame-graph material. Typed against cognet:* ONLY: a cognet
     * narrates its own world but can never forge kernel machinery events.
     */
    emit<K extends keyof CognetEventMap>(type: K, data: CognetEventMap[K]): void

    /**
     * Report a format violation in the model's output — the model broke the
     * grammar this cognet gave it.
     *
     * Separate from emit() because the OUTCOME is not telemetry: the kernel
     * commits it as axon:system:message, so AIR renders it into the next
     * tick's <system> block and the model reads its own violation and
     * corrects. That is a system fact, and a cognet may not forge one
     * directly (see emit's typing) — so it describes the fault and the kernel
     * writes it.
     *
     * Why a cognet needs this at all: the runtime detects violations it can
     * see in the token stream (an unclosed block), but a cognet that renders
     * the model's output detects its own class of them — an interpolation
     * naming a binding the script never declared. Without this verb the only
     * way to make such a fault visible was to speak it as the agent's own
     * message, which puts a diagnostic in the agent's voice and shows the
     * user machinery they cannot act on.
     *
     * Deliberately NOT user-facing: hosts hide these (see the TUI's
     * isEntryVisible) so a violation is a retry the model performs, not an
     * error the user watches it make.
     */
    fault(input: { code: string; message: string; excerpt?: string }): Promise<void>

    /**
     * Private cognitive state + read-only episodic access — see KernelStore.
     * Persistence is a mediated resource like inference (stream) and
     * execution (run): the cognet declares intent, the kernel owns
     * mechanism (paths, atomicity, substrate — fs today, anything
     * tomorrow, invisible either way).
     */
    store: KernelStore

    /**
     * Long-term knowledge — durable, human-readable material the brain
     * consults and maintains. See KernelKnowledge for the doctrine.
     *
     * Mediated for the same reason `store` is: the cognet declares a name,
     * the kernel owns the path. It is a peer of store, not a replacement —
     * store is a private cache over the log, knowledge is shared input that
     * outlives every session and is published with the agent.
     */
    knowledge: KernelKnowledge

    /**
     * Wake the brain — the mind's own rhythm, driven from inside it.
     *
     * THE BODY DOES NOT DRIVE THE BRAIN. This used to be `axon.tick()` on the
     * agent handle, so a plugin in the body decided how often the mind ran.
     * That is the body asserting a fact about cognition it cannot know: how
     * fast frames arrive is a property of a sensor, how often it is worth
     * thinking about them is a property of a mind. It also broke the swap
     * test — a body that drives a specific brain has to be rewritten when the
     * brain changes, which is exactly the coupling the split exists to
     * prevent. And it has no answer under composition: two sensors at 31Hz
     * and 60Hz cannot both be "the" tick rate.
     *
     * So the body only ever emits stimuli, and the brain decides when to
     * look. A cognet plugin owns the clock:
     *
     * ```ts
     * // plugins/clock.ts
     * export default definePlugin(({ hooks }) => {
     *     hooks.on("boot", () => {
     *         setInterval(() => void kernel.wake(), 1000 / 30)
     *     })
     * })
     * ```
     *
     * Resolves with this wake's ordinal AS SOON AS IT IS ADMITTED — never
     * when it completes. A driver that awaited completion would serialise the
     * overlap that continuous mode exists to allow, turning `await tick()`
     * into skip-on-overlap by the back door.
     *
     * Continuous cognets only. An invocation cognet is woken by a stimulus
     * arriving, and waking itself would be a second, contradictory trigger.
     *
     * Named `wake`, not `tick`, because that is what it does: it invokes the
     * loop. A tick is one ITERATION inside a wake — the counter `phase()`
     * telemetry stamps against (`cognet:tick:*`). Two scales, two words.
     */
    wake(): Promise<number>

    /**
     * A snapshot of the scheduler's clock. A function, not a live getter:
     * with wakes overlapping, the count moves between reads, and a value read
     * at a moment is honest where a live reference is not.
     */
    clock(): KernelClock

}

/**
 * What the brain can know about its own rhythm.
 *
 * Deliberately thin. `ticks` is what a multi-rate mind needs to schedule
 * itself against — "every fourth tick, do the slow thing" — and nothing more
 * has earned a place here yet.
 */
export type KernelClock = {
    /**
     * Wakes admitted since boot. Process-lifetime and monotonic.
     *
     * NOT the per-wake tick counter that `phase()` telemetry stamps against
     * (see Clock in @arcforge/cognet, which resets every wake). Two different
     * numbers at two scales: this counts how many times the brain has been
     * woken, that counts how far the current wake has got.
     */
    wakes: number
}

/**
 * What a wake delivers: a diff and a leash, nothing else. Wake-scoped
 * things arrive HERE, never on the ABI.
 *
 * There is deliberately NO push/delta channel: a temporally-extended
 * emission is expressed through output() itself using the chunking
 * standard (AxonChunk in stdio/shared.ts — correlated entries, closed by
 * final). Chunks are ordinary committed entries, so they reach every
 * observer through the commit pipeline like any other fact; the wire
 * carries entries only, and the cognet never addresses a caller.
 */
export type CognetWake = {
    /**
     * Stimuli committed since the last wake, in seq order. Narrowly typed
     * to stimulus:* only — the cognet's whole input contract, mirroring
     * output() being its whole unmediated write contract. It never has to
     * handle every entry family that exists, only what it can actually
     * receive.
     */
    stimuli: readonly AxonStimulusEntry[]
    /**
     * Kernel interrupt, for the cognet's OWN work.
     *
     * Everything the kernel mediates — run(), stream() — is cancelled by the
     * kernel itself, unconditionally: a wake's cancellation is not something
     * a program opts into, and threading a signal by hand meant one missing
     * argument made an operation unkillable. Those verbs take no signal at
     * all now.
     *
     * This is what remains: the loop's own units of work between those
     * calls — folding state, evaluating a stop condition, anything running
     * in cognet code. A JS function cannot be preempted, so honouring this
     * is cooperative and always will be. Check it between units and return.
     */
    signal: AbortSignal
}
