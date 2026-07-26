import type { AxonError } from "../../error"
import type { AxonEventUnion } from "../envelope"

export type AxonTestEventContext = {
    testRunId: string
    file?: string
    suiteId?: string
    testId?: string
    hookId?: string
    /** Execution count for retries/repeats of one declared test, zero-based. */
    attempt?: number
}

export type AxonTestHookKind = "beforeAll" | "beforeEach" | "afterEach" | "afterAll"
export type AxonTestStatus = "passed" | "failed" | "cancelled"

export type AxonTestEventMap = {
    "test:run:start": { files: string[] }
    "test:run:complete": { status: AxonTestStatus; durationMs: number; passed: number; failed: number; skipped: number; todo: number }

    "test:file:start": {}
    "test:file:complete": { exitCode: number | null; durationMs: number }

    "test:suite:declare": { name: string; parentSuiteId?: string; mode: "run" | "only" | "skip" | "todo" }
    "test:suite:start": { name: string }
    "test:suite:complete": { name: string; durationMs: number }

    "test:case:declare": { name: string; suite: string[]; mode: "run" | "only" | "skip" | "todo" | "failing" }
    "test:case:start": { name: string; suite: string[] }
    "test:case:pass": { durationMs: number }
    "test:case:fail": { durationMs: number; error: AxonError }
    "test:case:skip": { reason?: string }
    "test:case:todo": {}

    "test:hook:start": { kind: AxonTestHookKind }
    "test:hook:complete": { kind: AxonTestHookKind; durationMs: number }
    "test:hook:fail": { kind: AxonTestHookKind; durationMs: number; error: AxonError }

    "test:console": { level: "log" | "info" | "warn" | "error" | "debug"; values: string[] }
    "test:process:fault": { kind: "uncaught" | "unhandled" | "exit" | "protocol"; error: AxonError }
}

export type AxonTestEvent = AxonEventUnion<AxonTestEventMap, AxonTestEventContext>

/** Unstamped child-process frame. The parent owns id/time/sequence. */
export type AxonTestEventFrame = {
    [K in keyof AxonTestEventMap]: {
        type: K
        context: Omit<AxonTestEventContext, "testRunId">
        data: AxonTestEventMap[K]
    }
}[keyof AxonTestEventMap]
