import { HindsightClient } from "@vectorize-io/hindsight-client"

/** Retrieval/reasoning effort accepted by Hindsight. */
export type HindsightBudget = "low" | "mid" | "high"

// Public signatures name these SDK types, so re-export them for Axon's tool declaration compiler.
export type {
    BankProfileResponse,
    RecallResponse,
    ReflectResponse,
    RetainResponse,
    VersionResponse,
} from "@vectorize-io/hindsight-client"

import type {
    // BankProfileResponse,
    RecallResponse,
    ReflectResponse,
    RetainResponse,
    VersionResponse,
} from "@vectorize-io/hindsight-client"

export type RecallOptions = {
    /** Restrict results to memory types such as "world", "experience", or "observation". */
    types?: string[]
    /** Retrieval effort. Higher budgets may take longer. */
    budget?: HindsightBudget
    /** Cap the result payload placed into the agent context. */
    maxTokens?: number
    /** Return entity summaries alongside matched memories. */
    includeEntities?: boolean
    /** Return source chunks alongside matched memories. */
    includeChunks?: boolean
    /** Restrict retrieval to memories carrying these tags. */
    tags?: string[]
    /** How supplied tags are matched. */
    tagsMatch?: "any" | "all" | "any_strict" | "all_strict" | "exact"
}

export type ReflectOptions = {
    /** Additional context for this reasoning request; it is not retained. */
    context?: string
    /** Reasoning/retrieval effort. Higher budgets may take longer. */
    budget?: HindsightBudget
    /** Restrict the memories considered by tags. */
    tags?: string[]
    /** How supplied tags are matched. */
    tagsMatch?: "any" | "all" | "any_strict" | "all_strict" | "exact"
    /** Include the memories and directives used to produce the answer. */
    includeFacts?: boolean
}

export type RetainOptions = {
    /** When the described event occurred, rather than when it was retained. */
    timestamp?: Date | string
    /** Provenance or framing for Hindsight's extraction step. */
    context?: string
    /** Small, caller-defined provenance values attached to this memory. */
    metadata?: Record<string, string>
    /**
     * Stable source identifier. Reusing it replaces the existing document by
     * default; use updateMode: "append" for growing sources such as transcripts.
     */
    documentId?: string
    /** Tags for filtering and observation scoping. */
    tags?: string[]
    /** Process in the background and return an operation ID to track separately. */
    async?: boolean
    /** Caller-supplied UUID for idempotent retries of async retains. */
    operationId?: string
    /** Whether an existing document is replaced (default) or appended to. */
    updateMode?: "replace" | "append"
    /** Name of a server-defined extraction strategy. */
    strategy?: string
}

function client(): HindsightClient {
    const baseUrl = process.env.HINDSIGHT_BASE_URL?.trim()
    if (!baseUrl) {
        throw new Error("hindsight: HINDSIGHT_BASE_URL is required")
    }

    const apiKey = process.env.HINDSIGHT_API_KEY?.trim()
    return new HindsightClient({
        baseUrl: baseUrl.replace(/\/+$/, ""),
        ...(apiKey ? { apiKey } : {}),
        userAgent: "axon-hindsight/0.1.0",
    })
}

function bankId(bankId: string): string {
    const value = bankId.trim()
    if (!value) throw new Error("hindsight: bankId must not be empty")
    return value
}

/**
 * Hindsight is an external, bank-scoped memory service. These tools are
 * deliberate primitives: they neither automatically retain conversations nor
 * silently inject recalled memories into agent context.
 */
export const hindsight = {
    /**
     * Verify Hindsight connectivity and discover the deployment's API version and
     * supported features. Call this during setup before using a deployment.
     */
    async getVersion(): Promise<VersionResponse> {
        return client().getVersion()
    },

    /**
     * Store information in an explicitly selected memory bank. Hindsight extracts
     * facts and relationships from content; it is not a raw transcript store.
     *
     * For a large import, use `async: true` and retain the returned operation ID.
     * An async retain is not necessarily searchable immediately.
     */
    async retain(bankIdValue: string, content: string, options: RetainOptions = {}): Promise<RetainResponse> {
        if (!content.trim()) throw new Error("hindsight: content must not be empty")
        return client().retain(bankId(bankIdValue), content, options)
    },

    /**
     * Retrieve ranked memory evidence. Prefer this over reflect when the caller
     * needs facts to reason over itself or needs to cite returned memory content.
     */
    async recall(bankIdValue: string, query: string, options: RecallOptions = {}): Promise<RecallResponse> {
        if (!query.trim()) throw new Error("hindsight: query must not be empty")
        return client().recall(bankId(bankIdValue), query, options)
    },

    /**
     * Ask Hindsight to generate an answer grounded in a bank's memories, mission,
     * directives, disposition, and (unless excluded server-side) mental models.
     *
     * This invokes Hindsight's configured LLM and is intentionally distinct from
     * recall, which only returns retrieved evidence.
     */
    async reflect(bankIdValue: string, query: string, options: ReflectOptions = {}): Promise<ReflectResponse> {
        if (!query.trim()) throw new Error("hindsight: query must not be empty")
        return client().reflect(bankId(bankIdValue), query, options)
    },
}
