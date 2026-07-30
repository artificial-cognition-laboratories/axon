import { isSpanEnd, isSpanStart, spanStem } from "./events/span"

/**
 * The session reader — turns the flat JSONL back into the nested shape of
 * what actually happened.
 *
 * This is what the span vocabulary is FOR. Because the session is one file
 * with one serialized writer (disk order IS commit order, `time.seq`
 * authoritative) and the scheduler admits one wake at a time, nesting is
 * exactly time containment: a span's parent is the innermost span still
 * open when it started. That is not a heuristic — given one writer and one
 * logical thread of execution it is an exact reconstruction, which is why
 * this needs no parentSpanId and why none is ever emitted (see envelope.ts).
 *
 * An agent author debugging a bad tick wants "what happened inside this
 * phase, in order" — not a flat 400-line stream. That is this function.
 */

/** The minimum an event must have to be readable — satisfied by every AxonEvent. */
export type ReadableEvent = {
    type: string
    time: { seq: number; ms: number }
    context: { runId?: string }
    data: Record<string, unknown>
}

export type SpanNode<E extends ReadableEvent = ReadableEvent> = {
    /** The family, e.g. "kernel:run" — the triad's shared stem. */
    stem: string
    /** What distinguishes this bracket from its siblings (tick number, phase name, command id). */
    key: string
    /** How the span settled. "open" means it never closed — a truncated log or a crash mid-span. */
    outcome: "complete" | "failed" | "interrupted" | "open"
    start: E
    /** Absent while the span is open. */
    end?: E
    durationMs?: number
    /** Nested spans and bare events, in the order they occurred. */
    children: ReadNode<E>[]
}

/** A bare event — one that isn't half of a bracket. */
export type LeafNode<E extends ReadableEvent = ReadableEvent> = {
    stem: null
    event: E
}

export type ReadNode<E extends ReadableEvent = ReadableEvent> = SpanNode<E> | LeafNode<E>

export function isSpanNode<E extends ReadableEvent>(node: ReadNode<E>): node is SpanNode<E> {
    return node.stem !== null
}

/**
 * What names THIS bracket among its siblings of the same stem.
 *
 * Every span family that can have concurrent or repeated siblings puts its
 * discriminator in the payload (tick number, phase name, command id) — the
 * one exception being engine calls, which carry a stamped spanId because
 * two can genuinely interleave. Families with neither are singular per run
 * and key on the empty string.
 */
function bracketKey(event: ReadableEvent): string {
    const d = event.data
    const parts: string[] = []
    for (const field of ["tick", "phase", "system", "id", "procId", "namespace", "name", "fn"] as const) {
        const value = d[field]
        if (typeof value === "string" || typeof value === "number") parts.push(`${field}:${value}`)
    }
    const spanId = (event.context as { spanId?: string }).spanId
    if (spanId) parts.push(`span:${spanId}`)
    return parts.join("|")
}

function outcomeOf(type: string): "complete" | "failed" | "interrupted" {
    if (type.endsWith(":failed")) return "failed"
    if (type.endsWith(":interrupted")) return "interrupted"
    return "complete"
}

/**
 * Rebuild the tree.
 *
 * Events are read in `time.seq` order (sorted here so a caller can pass the
 * three session views concatenated without pre-merging). A `:start` pushes
 * a span; a matching end pops it and everything between becomes its
 * children. Spans still open at the end of input stay `outcome: "open"` —
 * an honest report of a truncated log, never silently dropped or
 * force-closed.
 *
 * An end with no matching start (reading a window that began mid-span) is
 * kept as a leaf rather than discarded: the log said it happened, so the
 * reader says it happened.
 */
export function readSession<E extends ReadableEvent>(events: readonly E[]): ReadNode<E>[] {
    const ordered = [...events].sort((a, b) => a.time.seq - b.time.seq)

    const roots: ReadNode<E>[] = []
    const stack: SpanNode<E>[] = []
    const siblings = () => (stack.length > 0 ? stack[stack.length - 1]!.children : roots)

    for (const event of ordered) {
        if (isSpanStart(event.type)) {
            const node: SpanNode<E> = {
                stem: spanStem(event.type),
                key: bracketKey(event),
                outcome: "open",
                start: event,
                children: [],
            }
            siblings().push(node)
            stack.push(node)
            continue
        }

        if (isSpanEnd(event.type)) {
            const stem = spanStem(event.type)
            const key = bracketKey(event)
            // Search from the innermost outward: a well-formed log closes the
            // top of the stack, but a family that failed to close an inner
            // span must not swallow its parent's end event.
            const depth = findOpen(stack, stem, key)
            if (depth !== -1) {
                // Anything still open inside this one never closed — pop it
                // too, leaving its outcome as "open" so the gap is visible.
                const node = stack[depth]!
                stack.length = depth
                node.outcome = outcomeOf(event.type)
                node.end = event
                const durationMs = event.data.durationMs
                if (typeof durationMs === "number") node.durationMs = durationMs
                continue
            }
        }

        siblings().push({ stem: null, event })
    }

    return roots
}

/** Innermost open span matching stem+key, or -1. */
function findOpen<E extends ReadableEvent>(stack: SpanNode<E>[], stem: string, key: string): number {
    for (let i = stack.length - 1; i >= 0; i--) {
        const node = stack[i]!
        if (node.stem === stem && node.key === key) return i
    }
    return -1
}

/**
 * Render the tree as indented text — the view an agent author actually
 * reads when a tick went wrong. Deliberately plain: one line per node,
 * outcome and duration where they exist.
 */
export function formatSession<E extends ReadableEvent>(nodes: readonly ReadNode<E>[], indent = 0): string {
    const pad = "  ".repeat(indent)
    const lines: string[] = []

    for (const node of nodes) {
        if (!isSpanNode(node)) {
            lines.push(`${pad}· ${node.event.type}`)
            continue
        }
        const duration = node.durationMs !== undefined ? ` ${node.durationMs}ms` : ""
        const outcome = node.outcome === "complete" ? "" : ` [${node.outcome}]`
        const key = node.key ? ` (${node.key})` : ""
        lines.push(`${pad}▸ ${node.stem}${key}${duration}${outcome}`)
        if (node.children.length > 0) lines.push(formatSession(node.children, indent + 1))
    }

    return lines.join("\n")
}
