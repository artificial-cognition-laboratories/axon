import type { CapsulePolicy, EscalationCall, PolicyBucket, PolicyRule, ResolvedCapsulePolicy, ToolBucket } from "./policy"
import type { AxonScopeModule } from "./scope"

export type CapsuleHostRequest = {
    method: string
    input: unknown
    signal: AbortSignal
}

export type CapsuleHost = {
    call(request: CapsuleHostRequest): Promise<unknown>
}

/**
 * A tool loaded into the capsule's global scope at boot.
 * The namespace becomes the global name inside run() — e.g. "fs" → fs.read().
 */
export type CapsuleTool =
    | {
        namespace: string
        /** Exact model-facing declarations for the globals this tool installs. */
        scope: AxonScopeModule
        /** Bundled TypeScript source (cloud path). Must default-export { name, exports }. */
        source: string
      }
    | {
        namespace: string
        /** Exact model-facing declarations for the globals this tool installs. */
        scope: AxonScopeModule
        /** Absolute path to the tool file (local path). Imported directly — native addons resolve. */
        path: string
      }

/**
 * Everything the capsule is built from. `env` merges onto the host's
 * inherited environment — secret stripping is the caller's compile step, not
 * capsule behavior. `cwd` is where it lives, `tools` is its entire scope,
 * `policy` is what it may do (mediator + OS confinement, see CapsulePolicy).
 *
 * Capsule(config) wires; capsule.boot() spawns.
 */
export type CapsuleBlueprint = {
    /** Display name for events/debugging. */
    name?: string

    /** Working directory of the subprocess. */
    cwd: string

    /** Merged onto the host's inherited environment — can override or narrow, but never starts from a blank slate. */
    env: Record<string, string>

    /** Tools loaded into global scope before boot() resolves. */
    tools: CapsuleTool[]

    /** What the sandbox may do — mediator gates + OS confinement (see CapsulePolicy). */
    /**
     * The policy as the enforcer reads it — RESOLVED, not authored.
     *
     * `ResolvedCapsulePolicy` rather than `CapsulePolicy` because a rule here
     * may be a carried profile/agent pair, which is a shape nobody writes and
     * every enforcement point must handle. The authored form is
     * `CapsulePartialConfig["policy"]` below.
     */
    policy: ResolvedCapsulePolicy

    /**
     * Answer policy escalations. One callback, one decision — default deny.
     * Called when the mediator hits an "escalate" rule.
     */
    escalate?: (call: EscalationCall) => Promise<boolean>

    /** Trusted host services projected into globalThis.axon through RPC. */
    host?: CapsuleHost

    boot?: {
        /** Max ms to wait for the boot handshake. Default 10_000. */
        timeoutMs?: number
    }

    restart?: {
        /** Max crash restarts inside the window before the capsule is declared dead. Default 3. */
        max?: number
        /** Crash window in ms. Default 5_000. */
        windowMs?: number
    }

    /**
     * Override the default `bun run <entrypoint>` spawn. Used by tests and
     * internally by OS confinement (the bwrap/systemd wrapper is composed by
     * the capsule — callers normally never set this).
     */
    spawn?: {
        command: string
        args: string[]
    }
}

/**
 * What Capsule()/capsule.update() actually accept. Partial<CapsuleBlueprint>
 * is shallow — policy would have to be supplied whole or not at all, which
 * defeats the point of a blueprint seam. policy (and process within it) get
 * their own deep-partial here so a caller can pass just the one field they
 * care about; CapsuleBlueprint()/mergeCapsuleConfig() fill in the rest.
 */
export type CapsulePartialConfig = Partial<Omit<CapsuleBlueprint, "policy">> & {
    /**
     * As AUTHORED — every enforcement surface also accepts one bare rule
     * covering the whole surface (`tools: "escalate"`), which `Blueprint()`
     * normalises into the keyed shape the capsule enforces. See `PolicyBucket`.
     */
    policy?: Partial<Omit<CapsulePolicy, "tools" | "shell">> & {
        tools?: ToolBucket
        shell?: NonNullable<CapsulePolicy["shell"]> | boolean
    }
}
