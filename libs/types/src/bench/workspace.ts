import type { BenchExecutionContext, BenchTestStatus } from "./execution"
import type { BenchHash } from "./value"

export type BenchWorkspaceSource =
    | { kind: "empty" }
    | { kind: "directory"; path: string }

export type BenchWorkspaceRetention = "never" | "failed" | "always"

export type BenchWorkspaceDefinition = {
    /** Shorthand for source: { kind: "directory", path: template }. */
    template?: string
    source?: BenchWorkspaceSource
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

