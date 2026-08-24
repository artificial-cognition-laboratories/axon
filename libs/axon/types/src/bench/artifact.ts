import type { BenchExecutionContext } from "./execution"
import type { BenchHash, BenchValue } from "./value"

export type BenchArtifactRole = "evidence" | "output" | "replay" | "report"

export type BenchArtifactDefinition = {
    id: string
    label: string
    description: string
    role?: BenchArtifactRole
    mediaTypes?: string[]
    /** URI identifying the artifact body's semantic schema. */
    schema?: string
}
/** Runtime input. The harness persists content and emits a portable reference. */
export type BenchArtifactInput = {
    mediaType: string
    role?: BenchArtifactRole
    schema?: string
    content: string | Uint8Array | BenchValue
}

/** Content-addressed evidence; charts are projections, never stored artifacts. */
export type BenchArtifactRef = {
    id: string
    definitionId: string
    label?: string
    description?: string
    role: BenchArtifactRole
    owner?: "benchmark" | "framework"
    display?: "hidden" | "default"
    mediaType: string
    schema?: string
    hash: BenchHash
    bytes: number
    ref: string
    context: BenchExecutionContext
    createdAt: string
}
