import type { ProcOutputStream, ProcQueryMatch, ProcQueryOptions, ProcQuerySnapshot } from "../../../types"

/**
 * Pure query engine over buffered proc output. No state, no I/O —
 * (buffers, options) in, snapshot out.
 */

export function queryBuffers(
    procId: string,
    stdout: string[],
    stderr: string[],
    opts: ProcQueryOptions
): ProcQuerySnapshot {
    const include = opts.include ?? ["stdout"]
    const caseSensitive = opts.caseSensitive ?? false

    let chunks: string[]
    if (include.includes("stdout") && include.includes("stderr")) {
        chunks = [...stdout, ...stderr]
    } else if (include.includes("stderr")) {
        chunks = stderr
    } else {
        chunks = stdout
    }

    // Array items may contain embedded newlines — expand to lines.
    const lines: string[] = []
    for (const chunk of chunks) {
        for (const line of chunk.split(/\r?\n/)) lines.push(line)
    }

    const stream: ProcQuerySnapshot["stream"] =
        include.includes("stdout") && include.includes("stderr")
            ? "both"
            : include.includes("stderr") ? "stderr" : "stdout"

    return runQuery(procId, lines, stream, opts, caseSensitive)
}

/** First line matching `regex` → its capture groups. Empty when no match. */
export function extractFromBuffers(
    stdout: string[],
    stderr: string[],
    regex: RegExp,
    include: ProcOutputStream[] = ["stdout"]
): string[] {
    const chunks = [
        ...(include.includes("stdout") ? stdout : []),
        ...(include.includes("stderr") ? stderr : []),
    ]
    for (const chunk of chunks) {
        for (const line of chunk.split(/\r?\n/)) {
            const m = line.match(regex)
            if (m) return m.slice(1)
        }
    }
    return []
}

// ─── Core ─────────────────────────────────────────────────────────────────────

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function runQuery(
    procId: string,
    allLines: string[],
    stream: ProcQuerySnapshot["stream"],
    opts: ProcQueryOptions,
    caseSensitive: boolean
): ProcQuerySnapshot {
    const totalLines = allLines.length

    // Windowing — applied to the raw buffer before filtering.
    let windowed = allLines
    if (opts.from !== undefined || opts.to !== undefined) {
        windowed = windowed.slice(opts.from ?? 0, opts.to)
    } else if (opts.head !== undefined) {
        windowed = windowed.slice(0, opts.head)
    } else if (opts.lines !== undefined) {
        windowed = windowed.slice(-opts.lines)
    }

    const searchRe = opts.search ? new RegExp(escapeRe(opts.search), caseSensitive ? "" : "i") : null
    const notRe = opts.not ? new RegExp(escapeRe(opts.not), caseSensitive ? "" : "i") : null
    const userRe = opts.regex ?? null
    const hasFilter = searchRe !== null || userRe !== null || notRe !== null

    if (!hasFilter) {
        return {
            procId,
            stream,
            lines: windowed,
            raw: windowed.join("\n"),
            matches: [],
            totalLines,
            matchedLines: windowed.length,
        }
    }

    function matches(line: string): boolean {
        if (notRe && notRe.test(line)) return false
        if (searchRe && !searchRe.test(line)) return false
        if (userRe && !userRe.test(line)) return false
        return true
    }

    const ctx = opts.context ?? 0
    const matchEntries: ProcQueryMatch[] = []
    const matchedSet = new Set<number>()

    for (let i = 0; i < windowed.length; i++) {
        const line = windowed[i]
        if (line === undefined || !matches(line)) continue
        matchedSet.add(i)
        matchEntries.push({
            line: i,
            text: line,
            before: ctx > 0 ? windowed.slice(Math.max(0, i - ctx), i) : [],
            after: ctx > 0 ? windowed.slice(i + 1, Math.min(windowed.length, i + 1 + ctx)) : [],
        })
    }

    const lines = windowed.filter((_, i) => matchedSet.has(i))

    return {
        procId,
        stream,
        lines,
        raw: lines.join("\n"),
        matches: matchEntries,
        totalLines,
        matchedLines: lines.length,
    }
}
