import type { AxonTestEventFrame } from "@arcforge/types"

/** The IPC channel test frames arrive on. Anything else is a domain extension's own traffic. */
export const CHANNEL = "axon:test"

/**
 * Every event type a test child may report.
 *
 * An allowlist rather than a shape check: the child is a subprocess running
 * user code, so a frame is untrusted input. Accepting an unknown `type` would
 * put an event into the authoritative stream that no consumer knows how to
 * read.
 */
const EVENT_TYPES = new Set<string>([
    "test:suite:declare", "test:suite:start", "test:suite:complete",
    "test:case:declare", "test:case:start", "test:case:pass", "test:case:fail",
    "test:case:skip", "test:case:todo",
    "test:hook:start", "test:hook:complete", "test:hook:fail",
    "test:console", "test:process:fault",
])

export type ChildMessage = { channel: typeof CHANNEL; frame: AxonTestEventFrame }

/** Whether a message is addressed to the test channel at all — extensions use their own. */
export function isTestChannel(value: unknown): boolean {
    return Boolean(value) && typeof value === "object"
        && (value as { channel?: unknown }).channel === CHANNEL
}

/** Whether a message is a well-formed test frame this runner can record. */
export function isFrame(value: unknown): value is ChildMessage {
    if (!isTestChannel(value)) return false

    const frame = (value as { frame?: { type?: unknown; context?: unknown; data?: unknown } }).frame
    return typeof frame?.type === "string"
        && EVENT_TYPES.has(frame.type)
        && typeof frame.context === "object"
        && typeof frame.data === "object"
}
