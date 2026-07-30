import type { BenchExecutionContext, BenchTestStatus } from "./execution"
import type { BenchHash } from "./value"

export type BenchWorkspaceSource =
    | { kind: "empty" }
    | { kind: "directory"; path: string }

export type BenchWorkspaceRetention = "never" | "failed" | "always"

export type BenchWorkspaceDefinition = {
    /**
     * Directory holding the agent's world, copied fresh per iteration.
     * Defaults to "./workspace".
     *
     * Named for what it IS rather than the copy that implements it: the
     * directory is the working environment the agent sees, and nothing
     * outside it is visible to the subject. `fixtures/` sits beside it for
     * things only the bench author uses — setup, assertions, judge rubrics.
     */
    source?: string | BenchWorkspaceSource
    retain?: BenchWorkspaceRetention
    capture?: {
        changes?: boolean
        display?: "hidden" | "default"
        ignore?: string[]
        maxBytes?: number
    }
}

export type BenchResolvedWorkspaceDefinition = {
    source: BenchWorkspaceSource
    retain: BenchWorkspaceRetention
    capture: {
        changes: boolean
        display: "hidden" | "default"
        ignore: string[]
        maxBytes: number
    }
}

export type BenchWorkspaceTemplate = {
    kind: BenchWorkspaceSource["kind"]
    hash: BenchHash
    files: number
    bytes: number
}

export type BenchWorkspaceInstance = {
    id: string
    /** Local execution detail. Never enters portable manifests or events. */
    path: string
    context: BenchExecutionContext
    template: BenchWorkspaceTemplate
}

export type BenchWorkspaceFileState = {
    hash: BenchHash
    bytes: number
    mode: number
    ref?: string
}

export type BenchWorkspaceChange = {
    path: string
    kind: "added" | "modified" | "deleted"
    before?: BenchWorkspaceFileState
    after?: BenchWorkspaceFileState
}

export type BenchWorkspaceResult = {
    workspaceId: string
    templateHash: BenchHash
    retained: boolean
    outcome: BenchTestStatus
    changes: BenchWorkspaceChange[]
    summary: {
        added: number
        modified: number
        deleted: number
        bytesChanged: number
    }
}


/**
 * What a scenario can ask about the agent's world after it has acted.
 *
 * `changed()` and `diff()` are only answerable by the harness: both need the
 * world as it was before the subject booted, and by the time a test runs that
 * state exists solely in the baseline snapshot.
 */
export type BenchWorkspaceHandle = {
    readonly path: string
    toString(): string
    read(relativePath: string): Promise<string>
    exists(relativePath: string): Promise<boolean>
    changed(): Promise<string[]>
    changes(): Promise<BenchWorkspaceChange[]>
    diff(): Promise<string>
    tests: {
        pass(opts?: { timeoutMs?: number }): Promise<boolean>
        output(opts?: { timeoutMs?: number }): Promise<{ ok: boolean; text: string }>
    }
}
