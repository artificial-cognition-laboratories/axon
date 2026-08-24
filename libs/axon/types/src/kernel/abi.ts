import type { AxonEngineRequest } from "../engine"
import type { AxonEngineEvent } from "../session/events/engine"
import type { AxonEntry } from "../session/session"
import type { AxonOutputEvent } from "../session/events/stdio/output"
import type { AxonStimulusEntry } from "../session/events/stdio/stimuli"
import type { CognetEventMap } from "../session/events/cognet"
import type { AxonScope } from "../scope"

/**
 * The current kernel ABI contract version. Program definitions declare the
 * version they were built against; the kernel refuses loudly on mismatch.
 * Bump on any breaking change to KernelAbi or CognetWake — reluctantly,
 * like the syscall table it is.
 *
 * THE VERSIONED SURFACE IS MORE THAN THE FUNCTION SHAPES. A cognet is a
 * prebuilt bundle: it compiled against a snapshot of every payload type
 * this file references — AxonOutputEvent (output), AxonEngineRequest /
 * AxonEngineEvent (stream), CognetEventMap (emit), AxonEntry
 * (the wake wire). A breaking change to ANY of those is a breaking change to the
 * ABI and requires a version bump, even though no signature here moved —
 * otherwise a stale bundle loads cleanly under a matching version number
 * and misreads events at runtime. Nothing enforces this mechanically yet;
 * the rule is the enforcement. (Additive changes — new event types, new
 * optional fields — are compatible, like new syscalls.)
 */
export const KERNEL_ABI_VERSION = "10"

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
     * Inference — messages in, structured engine events out. The kernel
     * mediates access to the provider (auth, metering, later quotas); the
     * program owns everything about what the messages contain. Yields raw
     * engine:* wire events (see session/events/engine.ts) — the cognet
     * decides what to do with each: output() a text block, run() a
     * typescript block. The kernel never pre-labels these as the cognet's
     * own committed output; that decision belongs to the cognet alone.
     */
    stream(req: AxonEngineRequest): AsyncGenerator<AxonEngineEvent>

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
    run(code: string, opts?: {
        /** Wake cancellation. The capsule must stop this block when aborted. */
        signal?: AbortSignal
    }): Promise<AxonRunResult>
    run(code: string[], opts?: {
        /** Wake cancellation. The capsule must stop every in-flight block when aborted. */
        signal?: AbortSignal
    }): Promise<AxonRunResult[]>

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
     * Private cognitive state + read-only episodic access — see KernelStore.
     * Persistence is a mediated resource like inference (stream) and
     * execution (run): the cognet declares intent, the kernel owns
     * mechanism (paths, atomicity, substrate — fs today, anything
     * tomorrow, invisible either way).
     */
    store: KernelStore

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

    /**
     * Absolute paths to the weights this cognet declared, by the name it gave
     * them. Empty when none were declared.
     *
     * ```ts
     * const session = await ort.InferenceSession.create(kernel.models.vad)
     * ```
     *
     * Handed over at load rather than read from the cognet's own config,
     * because a filesystem path is ENVIRONMENTAL: the same brain gets a
     * different absolute path on every machine, and must never learn that.
     * The config says which weights are needed; this says where they landed.
     *
     * Whether they were fetched from a registry, restored from a shared
     * cache, or baked into a deployment image is invisible here — the kernel
     * guarantees the file exists and was verified, nothing more.
     */
    models: Readonly<Record<string, string>>
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
    /** Kernel interrupt — programs must honor it between units of work. */
    signal: AbortSignal
}
