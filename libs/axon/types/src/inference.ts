/**
 * Inference requirements and supply — the contract between what a cognet
 * NEEDS and what a user HAS.
 *
 * The indirection is the point, and it is the same one `models:` already
 * makes for weights: the cognet declares a NAME it made up and the shape of
 * the thing that name stands for; the user declares a POOL of providers; a
 * resolver connects them. Neither side learns about the other. A cognet that
 * could name a provider would stop being portable to a machine that has a
 * different one, and a user who had to name a cognet's roles would be wiring
 * — which is the thing this exists to abolish.
 *
 * @see https://axon.arclabs.it/docs/v2/cognets/engine/kernel-contract
 */

/**
 * How an engine is CALLED. Closed, small, and expensive to extend on
 * purpose — each member is a distinct handle shape on the kernel ABI, so
 * adding one adds a verb.
 *
 * This is the axis that survives contact with the ~60 task tags a model hub
 * publishes, because those are discovery labels (three names for "image+text
 * in, text out") while these are interaction patterns. Summarization and
 * translation are prompts, not kinds; depth estimation and object detection
 * differ only in what the returned bytes MEAN, which is deliberately not
 * this package's business.
 *
 * - "generate"  — autoregressive, streamed, sampled. LLMs, VLMs, most TTS.
 * - "transform" — one shot in, one shot out. ASR, embeddings, classifiers,
 *                 detection, depth, segmentation, image generation.
 * - "stream"    — stateful sequential feed, order significant. VAD,
 *                 streaming ASR, trackers. Needs a session handle because
 *                 hidden state lives across calls.
 */
export type EngineType = "generate" | "transform" | "stream"

/**
 * What crosses the boundary, in and out.
 *
 * Open-ended by intent: this is a MATCHING vocabulary, not a payload
 * taxonomy. The kernel refuses to interpret what a depth map or an embedding
 * means — same refusal `models:` already makes about weights — so a member
 * here only has to be specific enough for a resolver to tell two models
 * apart.
 *
 * "score", "vector" and "depth" are output shapes rather than modalities in
 * the strict sense. They earn their place because a cognet asking for a VAD
 * and a cognet asking for speech-to-text both say `in: "audio"`, and the
 * output is the only thing that separates them.
 */
export type Modality =
    | "text"
    | "image"
    | "audio"
    | "video"
    | "vector"
    | "score"
    | "depth"

/**
 * One named engine a cognet requires, as declared in `cognet.config.ts`.
 *
 * CONSTRAINTS ARE STRUCTURAL ONLY. Every field here is something that
 * BREAKS the brain when unmet, never something that merely makes it worse:
 * a context window too small means the render does not fit; a text-only
 * model handed an image cannot answer at all. Quality is deliberately
 * absent — a weak model still parses, still fits, and still runs, so which
 * one to use is the user's tradeoff to make and never the cognet's to
 * refuse. That is also what keeps model benchmarking off this critical
 * path: nothing here needs a score to be resolvable.
 */
export type EngineRequirement = {
    /** Which handle shape the cognet's code is written against. */
    type: EngineType

    /** Accepted input modalities. A single value is shorthand for one. */
    in: Modality | Modality[]

    /** Produced output modalities. A single value is shorthand for one. */
    out: Modality | Modality[]

    /**
     * Minimum usable context window, in tokens. Only meaningful for
     * "generate" — a VAD has no context and declaring one is a category
     * error the resolver ignores rather than fails on.
     */
    context?: number

    /** The reply must be parseable as structured output (AIR blocks, JSON mode). */
    structured?: boolean

    /**
     * This role is fanned out — the cognet issues several calls at once and
     * wants as many as it can get.
     *
     * A REQUEST, never a threshold. The count a cognet would name is a fact
     * about a machine it cannot see, and asserting one turns "runs slowly"
     * into "refuses to install" for exactly the users who most need it to
     * degrade. One slot is N sequential calls: slower, still correct, never
     * zero. A cognet that wants to branch on how much it got reads `slots`
     * off the handle.
     */
    parallel?: boolean

    /**
     * The brain runs without this. Absent means required, and a required
     * role with no candidate is a hard failure at prepare.
     *
     * This is the whole degradation story: a cognet checks
     * `kernel.engine.has(name)` and takes a cheaper path when a role is
     * unfilled, which is what lets compression, filtering and attention land
     * without breaking a user who has one local model and no network.
     */
    optional?: boolean

    /**
     * This role is what the user's model picker edits.
     *
     * A CONVENTION of the binding layer, never a privilege in the kernel:
     * the handle a primary role returns is identical to any other. It exists
     * because "the current model" has to mean something to a UI, and naming
     * the role explicitly beats hardcoding the string "main" — a cognet with
     * two peer reasoners must not be forced to call one of them main.
     *
     * At most one per cognet.
     */
    primary?: boolean
}

/**
 * What a cognet declares — role name to requirement.
 *
 * A MAP, for the reason `models:` is a map: the key is the brain's own
 * vocabulary. `kernel.engine("percept")` says what the engine is FOR, and
 * swapping what fills it is the user's business, expressed nowhere in the
 * cognet's source.
 */
export type EngineRequirements = Record<string, EngineRequirement>

/**
 * One model a provider can actually supply, normalized across providers.
 *
 * The supply-side counterpart of EngineRequirement, and the thing a resolver
 * matches against. Deliberately a superset of what any single provider
 * reports: a field a provider cannot answer is absent, never fabricated, and
 * a matcher treats absent as "unknown" rather than "no" for everything
 * except the constraints a cognet declared.
 */
export type EngineCapability = {
    /** Provider-qualified identifier, e.g. "anthropic/claude-sonnet-4-6". */
    id: string

    /** Which provider can supply it — the route, in picker terms. */
    provider: string

    /** Human label for pickers and diagnostics. */
    name: string

    type: EngineType
    in: Modality[]
    out: Modality[]

    /** Context window in tokens. Absent when the source does not report one. */
    context?: number

    /** Structured output is supported. Absent means unknown. */
    structured?: boolean

    /**
     * Runs on this machine rather than over the network.
     *
     * The one fact that decides whether an agent works with the network off,
     * which is why it is a first-class field and not an inference from the
     * provider name.
     */
    local?: boolean

    /**
     * Concurrent calls this binding can sustain. Absent means unbounded
     * (the ordinary answer for a hosted route); 1 means strictly sequential.
     */
    slots?: number

    /** Weights footprint in bytes — what a local admission check measures against. */
    bytes?: number
}

/**
 * A resolved binding: the role, and what got put in it.
 *
 * The cognet never sees this. It is what `axon prepare` reports, what the
 * TUI renders, and what the kernel holds so `kernel.engine(name)` is a map
 * lookup rather than a query — resolution happens once, at boot, so a call
 * site can never block on it and can never fail differently on the second
 * tick than the first.
 */
export type EngineBinding = {
    role: string
    requirement: EngineRequirement
    capability: EngineCapability
    /** Concurrency actually granted — what the handle reports as `slots`. */
    slots: number
}

/** Why a role could not be filled — one entry per unmet requirement. */
export type EngineUnmet = {
    role: string
    requirement: EngineRequirement
    /**
     * Human-readable account of what was rejected and why, one line per
     * near-miss candidate. Present so `axon prepare` can say "your models
     * fit everything except the 100k context" instead of "unresolved".
     */
    reasons: string[]
}

/**
 * The outcome of resolution — every role accounted for, nothing thrown.
 *
 * Total rather than throwing because the caller decides severity: a missing
 * OPTIONAL role is ordinary and the brain degrades around it, while a
 * missing required one must stop `axon prepare`. A resolver that threw would
 * make the first case impossible to express.
 */
export type EngineResolution = {
    bound: EngineBinding[]
    /**
     * The model the agent pinned, when nothing available could supply it.
     *
     * A pin is a preference, so an unsatisfiable one is not an error — the
     * agent still runs on whatever ranking chose. But it must not be SILENT:
     * a user who picked a model and got a different one has to be told which,
     * and why, or the picker looks broken. Absent when there was no pin, or
     * when the pin was honoured.
     */
    unhonoured?: { pin: string; reason: string }
    /** Unfilled roles, both optional and required. */
    unmet: EngineUnmet[]
    /** Unfilled roles that were NOT optional — non-empty means the agent cannot run. */
    missing: EngineUnmet[]
}
