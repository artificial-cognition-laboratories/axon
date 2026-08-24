import type { AxonEngineFault, AxonEngineFaultCode } from "@arcforge/types"

/** Runtime carrier for a serializable engine fault. */
export class EngineFailure extends Error {
    readonly fault: AxonEngineFault

    constructor(fault: AxonEngineFault, options?: { cause?: unknown }) {
        super(fault.message, options)
        this.name = "EngineFailure"
        this.fault = fault
    }
}

export function failure(input: {
    code: AxonEngineFaultCode
    message: string
    retryable: boolean
    provider: string
    model?: string
    status?: number
    retryAfterMs?: number
    cause?: unknown
}): EngineFailure {
    const { cause, ...fault } = input
    return new EngineFailure(fault, { cause })
}

export function asEngineFault(error: unknown, fallback: { provider: string; model?: string }): AxonEngineFault {
    if (error instanceof EngineFailure) return error.fault

    if (error instanceof DOMException && error.name === "AbortError") {
        return { code: "ABORTED", message: error.message || "engine request aborted", retryable: false, ...fallback }
    }

    if (error instanceof SyntaxError) {
        return { code: "PROTOCOL", message: error.message, retryable: true, ...fallback }
    }

    if (error instanceof TypeError) {
        return { code: "TRANSPORT", message: error.message, retryable: true, ...fallback }
    }

    return {
        code: "UNKNOWN",
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
        ...fallback,
    }
}
