import { readFileSync } from "node:fs"

/**
 * Stack capture — one structured frame per call site, not an opaque string.
 * Bun/V8 already resolve real .ts file+line+column with no source-map step
 * (confirmed: running a .ts file directly reports its own source
 * coordinates).
 *
 * The source snippet is captured HERE, at construction time, not read from
 * disk later at render time. A TUI (or any renderer) replaying an AxonError
 * from the session log may be on a different machine, after the file
 * changed, or looking at a deployed bundle with no source on disk at all —
 * the snippet has to already be data on the frame, or it's gone forever.
 * render() only ever formats what's already here.
 */

// AxonSourceLine / AxonStackFrame are the wire contract — they live in
// @arcforge/types and are re-exported here so err's internals and existing
// importers resolve them from the same place.
export type { AxonSourceLine, AxonStackFrame } from "@arcforge/types"
import type { AxonSourceLine, AxonStackFrame } from "@arcforge/types"

const FRAME_PATTERN_NAMED = /at\s+(.*?)\s+\((.*?):(\d+):(\d+)\)/
const FRAME_PATTERN_BARE = /at\s+(.*?):(\d+):(\d+)/

/** Noise no caller ever wants rendered — framework internals, not their code. */
const IGNORED_PATH_SEGMENTS = ["node_modules", "native:", "internal", "bun:"]

const CONTEXT_LINES = 2

/**
 * Capture the stack at the current call site, skipping `skipFrames` of it
 * (use 1 to drop captureStack's own frame, 2 to also drop err()'s).
 */
export function captureStack(skipFrames: number = 1): AxonStackFrame[] {
    const raw = new Error().stack
    if (!raw) return []

    const lines = raw.split("\n").slice(1 + skipFrames) // drop the "Error" header line + requested frames
    return lines
        .map(parseLine)
        .filter(isRealFrame)
        .map(withSource)
}

/**
 * Parse an ALREADY-CAPTURED stack string (an unknown catch value's own
 * `.stack`, not ours) into structured frames — same real-frame filtering
 * and source-snippet capture as captureStack(), just over foreign text
 * instead of `new Error().stack`. This is how a wrapped cause's own throw
 * site becomes renderable: err()'s own frames point at the catch
 * boundary that called err(), never at the user code that actually threw.
 */
export function parseStack(raw: string): AxonStackFrame[] {
    return raw
        .split("\n")
        .slice(1) // drop the "Error: message" header line
        .map(parseLine)
        .filter(isRealFrame)
        .map(withSource)
}

/** The first non-framework frame in a foreign stack — the user's own throw site, best-effort. Null when the stack has no such frame (e.g. a bare string throw has no stack at all). */
export function firstRealFrame(raw: string | undefined): AxonStackFrame | null {
    if (!raw) return null
    return parseStack(raw)[0] ?? null
}

function parseLine(line: string): Omit<AxonStackFrame, "source"> {
    const named = line.match(FRAME_PATTERN_NAMED)
    if (named) {
        const [, fn, file, ln, col] = named
        return { functionName: fn ?? null, fileName: file ?? null, lineNumber: numberOr(ln), columnNumber: numberOr(col) }
    }
    const bare = line.match(FRAME_PATTERN_BARE)
    if (bare) {
        const [, file, ln, col] = bare
        return { functionName: null, fileName: file ?? null, lineNumber: numberOr(ln), columnNumber: numberOr(col) }
    }
    return { functionName: null, fileName: null, lineNumber: null, columnNumber: null }
}

function numberOr(value: string | undefined): number | null {
    if (value === undefined) return null
    const n = parseInt(value, 10)
    return Number.isNaN(n) ? null : n
}

function isRealFrame(frame: Omit<AxonStackFrame, "source">): boolean {
    if (!frame.fileName) return false
    return !IGNORED_PATH_SEGMENTS.some(segment => frame.fileName!.includes(segment))
}

function withSource(frame: Omit<AxonStackFrame, "source">): AxonStackFrame {
    return { ...frame, source: readSourceWindow(frame.fileName, frame.lineNumber) }
}

/** `CONTEXT_LINES` of real source ± the reported line, captured as plain data — no disk access after this point. */
function readSourceWindow(fileName: string | null, lineNumber: number | null): AxonSourceLine[] | null {
    if (!fileName || lineNumber === null) return null

    let text: string
    try {
        text = readFileSync(fileName, "utf-8")
    } catch {
        return null // source not reachable (deployed bundle, deleted file) — the header alone is still useful
    }

    const lines = text.split("\n")
    const targetIdx = lineNumber - 1
    if (targetIdx < 0 || targetIdx >= lines.length) return null

    const from = Math.max(0, targetIdx - CONTEXT_LINES)
    const to = Math.min(lines.length - 1, targetIdx + CONTEXT_LINES)

    const window: AxonSourceLine[] = []
    for (let i = from; i <= to; i++) window.push({ lineNumber: i + 1, text: lines[i] ?? "" })
    return window
}
