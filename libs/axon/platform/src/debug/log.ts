import { closeSync, openSync, readSync } from "node:fs"
import type { Event } from "./types"

/** Bytes read at a time. */
const CHUNK = 4 * 1024 * 1024

/**
 * Log — reads a session log a line at a time, from any byte offset.
 *
 * Never the whole file: a session log reaches hundreds of megabytes. A line
 * is handed over as text with the offset it starts at; whether it is worth
 * parsing is the caller's to decide, which is most of what makes a scan fast.
 */
export function Log() {
    return {
        /**
         * Every complete line from `from` on, in order. `visit` returns false
         * to stop. Returns the offset after the last complete line — where
         * the next scan starts; a line still being written is left for it.
         */
        scan(file: string, from: number, visit: (line: string, offset: number) => boolean | void): number {
            const handle = openSync(file, "r")
            try {
                const chunk = Buffer.alloc(CHUNK)
                let carry: Buffer = Buffer.alloc(0)
                let at = from
                let position = from
                for (;;) {
                    const read = readSync(handle, chunk, 0, CHUNK, position)
                    if (read === 0) return at
                    position += read
                    const bytes = carry.length ? Buffer.concat([carry, chunk.subarray(0, read)]) : chunk.subarray(0, read)
                    let start = 0
                    for (;;) {
                        const end = bytes.indexOf(0x0a, start)
                        if (end < 0) break
                        if (end > start && visit(bytes.toString("utf-8", start, end), at) === false) return at
                        at += end + 1 - start
                        start = end + 1
                    }
                    carry = Buffer.from(bytes.subarray(start))
                }
            } finally {
                closeSync(handle)
            }
        },

        /** A line as an event, or null when it is torn — cut short by a crash mid-write. */
        parse(line: string): Event | null {
            try {
                return JSON.parse(line) as Event
            } catch (cause) {
                if (cause instanceof SyntaxError) return null
                throw cause
            }
        },

        /** A line's type and time, read off its front without parsing it. Null for a line that is not an event. */
        head(line: string): { type: string; ms: number | null } | null {
            const type = /^\{"type":"([^"]+)"/.exec(line)
            if (!type) return null
            const ms = /"time":\{"ms":(\d+(?:\.\d+)?)/.exec(line.slice(0, 200))
            return { type: type[1]!, ms: ms ? Number(ms[1]) : null }
        },
    }
}

export type LogT = ReturnType<typeof Log>
