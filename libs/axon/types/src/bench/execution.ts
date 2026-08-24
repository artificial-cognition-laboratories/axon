import type { BenchCell } from "./matrix"

export type BenchTestStatus = "passed" | "failed" | "skipped" | "todo"

export type BenchTestRef = {
    id: string
    file: string
    suite: string[]
    name: string
}

/** Optional author-defined case beneath a native Bun test. */
export type BenchCaseRef = {
    id: string
    testId: string
    label?: string
}

export type BenchSessionRole = "subject" | "assessor"
export type BenchSessionRef = {
    agentId: string
    sessionId: string
    role: BenchSessionRole
}

export type BenchExecutionContext = {
    runId: string
    cellId: string
    testId?: string
    caseId?: string
    trial?: number
    attempt?: number
    sessionId?: string
}

export type BenchResourceUsage = {
    durationMs: number
    tokens: { input: number; output: number }
    /** Absent when any participating engine cannot be priced. */
    costUsd?: number
    engineCalls: number
    toolCalls: number
    errors: number
}

/** Assessor usage is isolated so judge cost cannot distort subject performance. */
export type BenchPhysics = {
    subject: BenchResourceUsage
    assessor?: BenchResourceUsage
    harness: { durationMs: number }
}

export type BenchFaultCode = "boot" | "timeout" | "budget" | "cancelled" | "process" | "protocol"
export type BenchFault = {
    code: BenchFaultCode
    message: string
    stack?: string
    context: BenchExecutionContext
}

export type BenchTrialRecord = {
    id: string
    test: BenchTestRef
    case?: BenchCaseRef
    cell: BenchCell
    trial: number
    attempt: number
    status: BenchTestStatus
    error?: { message: string; stack?: string }
    physics: BenchPhysics
    sessions: BenchSessionRef[]
    observationIds: string[]
    artifactIds: string[]
    fault?: BenchFault
}

