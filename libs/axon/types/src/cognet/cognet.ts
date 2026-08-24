import type { AxonBlueprint } from "../blueprint"
import type { KernelAbi, CognetWake } from "../kernel/abi"
import type { AxonEntryEvent } from "../session/events/entries"
import type { EngineRequirements } from "../inference"

/**
 * A cognet definition — one cognition artifact, what defineCognet()
 * produces. Built as its own project (registry/cognets/*), bundled by the CLI, and
 * carried into the runtime on blueprint.cognet — there is NO other way to
 * load a brain. Resident for the runtime's lifetime: the kernel loads it
 * once (exec), delivers wakes, and owns the execution record around every
 * wake.
 *
 * The definition owns everything inside: grammar, context rendering,
 * strategy, its own derived state (a cache of the log, rebuildable — never
 * authoritative). It touches nothing but the ABI it receives at load().
 */
/**
 * How the scheduler decides to invoke this cognet. Part of the cognet's own
 * declared identity — never blueprint-overridable, same trust direction as
 * `abi`: a cognet built for invocation-based wakes was never written to
 * tolerate an empty-stimuli tick, so an agent author can't flip this from
 * outside.
 *
 * - "invocation" — invoked once per admitted stimulus arrival, handed the
 *   full diff accumulated since the last invocation (may be more than one
 *   stimulus if several arrived while the previous wake was running).
 * - "continuous" — invoked by a clock the BODY owns, regardless of whether
 *   anything arrived; an empty diff is the ordinary steady state, not an
 *   edge case.
 *
 * Continuous carries no rate. It declares the SHAPE of the cognet — "tick
 * me, don't hand me a chat prompt" — which is what `stream()` and `tick()`
 * reject against, and nothing more. A `tickMs` lived here once and was
 * wrong in the same way a `salience` field on a stimulus is wrong: it had
 * the brain asserting how fast its world turns, which it cannot know and
 * must never assume. The rate lives with whatever drives `axon.tick()`.
 */
export type CognetSchedule =
    | { kind: "invocation" }
    | { kind: "continuous" }

/**
 * Cognet identity — what cognet.config.ts declares via defineCognet().
 * The compiled artifact composes this with the loop the entry script
 * registers; identity and behavior never live in the same file.
 */
export type CognetConfig = {
    name: string
    version: string

    /** The kernel ABI version this cognet was built against — checked at load, mismatch refuses loudly. */
    abi: string

    /** How the scheduler invokes this cognet. */
    mode: CognetSchedule

    /** Default wake mask — overridable by the blueprint's wakeOn. Absent = wake on everything. */
    wakeOn?: Array<keyof AxonEntryEvent>

    /**
     * Hard safety bound for one wake. Omitted means UNBOUNDED, which is the
     * default and the right one for most cognets.
     *
     * A ceiling cannot distinguish a runaway loop from a long job — the only
     * difference is whether the ticks accomplish anything, which a count
     * cannot see. Zero capped this at 32 and killed a run mid-verification
     * after forty clean turns of real work.
     *
     * Set it only where a wake is genuinely expected to converge in a known
     * number of steps (a classifier, a fixed pipeline), so exceeding it really
     * is a bug. For open-ended work, what bounds a wake is `<done/>`, the
     * user's interrupt, and the engine failing loudly.
     */
    maxTicksPerWake?: number

    /**
     * The inference this brain needs, by the names IT calls them.
     *
     * ```ts
     * engines: {
     *     main:    { type: "generate", in: "text", out: "text", context: 100_000 },
     *     percept: { type: "generate", in: "text", out: "text", parallel: true, optional: true },
     * }
     * ```
     *
     * The demand half of the same indirection `models:` makes for weights:
     * the key is the cognet's private vocabulary and the user never types it,
     * because a user who had to name a brain's roles would be wiring one
     * specific brain into their setup. `kernel.engine("percept")` says what
     * the engine is FOR; what fills it is decided at boot against whatever
     * providers the user declared.
     *
     * Constraints are STRUCTURAL — the things that break a brain rather than
     * slow it down. There is deliberately no way to demand a good model:
     * quality is the user's tradeoff, and a cognet that could refuse one
     * would be overruling the person whose machine it is running on.
     *
     * A required role with nothing to fill it fails at `axon prepare`, never
     * at the first tick. An optional one is the degradation path — the cognet
     * asks `kernel.engine.has(name)` and takes a cheaper route.
     */
    engines?: EngineRequirements

}

/**
 * Where a weight comes from.
 *
 * `"hf:owner/repo/path/to/file.onnx"` is the short form and covers almost
 * everything. The object form exists for the two things a string cannot
 * carry: a revision pin, and an expected hash.
 *
 * `sha256` is the difference between "verified" and "verified against
 * something I chose". Without it, first fetch is trust-on-first-use — the
 * bytes that arrived become the bytes that are correct forever. With it, a
 * compromised or silently-replaced upstream file fails loudly.
 */
export type ModelRef =
    | string
    | {
        /** `owner/repo` on Hugging Face. */
        hf: string
        /** Path within the repo — a repo is a directory, and repos hold many weights. */
        file: string
        /** Git revision. Defaults to `main`. */
        rev?: string
        /** Expected content hash. Pin it and a changed upstream is an error, not a surprise. */
        sha256?: string
    }

export type CognetDefinition = CognetConfig & {

    /** exec(): receives the syscall table. Runs once, before any wake. */
    load(kernel: KernelAbi): Promise<void> | void

    /** One scheduled episode. Returns when quiescent; throws on failure. */
    wake(wake: CognetWake): Promise<void>

    /** The agent changed (hot reload) — adopt the new blueprint before the next wake. */
    update?(blueprint: AxonBlueprint): void

    /** Brain off. Nothing durable to flush — durable writes already happened at commit time. */
    unload?(): Promise<void> | void
}
