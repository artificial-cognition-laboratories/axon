/** A model present on this machine, as Ollama reports it. */
export type LocalModel = {
    /** Fully qualified name including tag, e.g. "gemma3:4b" — what an engine references. */
    name: string
    /** On-disk size in bytes. */
    size: number
    /** Content digest of the manifest. */
    digest: string
    /** Last write, ISO-8601. */
    modifiedAt: string
    family: string
    /** e.g. "4.3B" — Ollama's own formatting, not ours to reinterpret. */
    parameters: string
    /** e.g. "Q4_K_M". */
    quantization: string
}

/** A model loaded into memory right now — a subset of what is downloaded. */
export type RunningModel = {
    name: string
    /** Resident size in bytes, which exceeds on-disk size once loaded. */
    size: number
    /** When Ollama will unload it unless used again, ISO-8601. */
    expiresAt: string
}

/**
 * A model offered for download.
 *
 * `size` is absent until resolved: the catalog records what a variant IS, and
 * only the registry knows how many bytes that currently amounts to.
 */
export type CatalogModel = {
    /** Fully qualified name including tag, e.g. "gemma3:4b". */
    name: string
    /** Base name without the tag, e.g. "gemma3" — the family a user picks first. */
    model: string
    tag: string
    /** One line, written for someone choosing between models. */
    description: string
    /** e.g. "4B" — as published, for comparison against `parameters` on a local model. */
    parameters: string
    /** Real download size in bytes, once the registry has been asked. */
    size?: number
    /** True when this exact name is already on disk. */
    installed?: boolean
    capabilities: Capability[]
}

export type Capability = "chat" | "tools" | "vision" | "embedding" | "thinking"

/** One step of a download. Byte counts are absent while Ollama resolves the manifest. */
export type PullProgress = {
    /** Ollama's own status line, e.g. "pulling manifest", "verifying sha256 digest". */
    status: string
    /** Bytes across EVERY layer seen so far, not just the one in flight. */
    total?: number
    completed?: number
    /**
     * 0–1 across the whole download, or null before any size is known.
     * Monotonic: it never goes backwards as one layer finishes and the next
     * starts.
     */
    percent: number | null
    /** True on the terminal event — the model is on disk and usable. */
    done: boolean
}

/** Whether the local daemon is reachable, and what it is. */
export type OllamaStatus =
    | { running: true; version: string }
    | { running: false; reason: string }
