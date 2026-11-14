import { readFileSync } from "node:fs"
import { basename } from "node:path"
import { Decoder, home, type Decoded } from "@arcforge/session"

/**
 * Ring — reads a session's telemetry: the binary window that holds every
 * tick, system run and component write (see TELEMETRY_EVENTS).
 *
 * A window, not a record: the oldest segments are deleted as new ones are
 * written, so what is here is the last stretch of the session and nothing
 * before it. A segment decodes on its own.
 */
export function Ring() {
    return {
        /** The segments still on disk, oldest first. */
        segments(data: string, id: string): Array<{ name: string; file: string; bytes: number }> {
            return home.data.telemetry.existing(data, id).map(segment => ({ name: basename(segment.file), file: segment.file, bytes: segment.bytes }))
        },

        /**
         * Every event of one segment, in order. `numbers` is how a long run
         * of them comes back: `array` as the log would give it, for an
         * answer; `typed` for a reader that only counts, at a third the time.
         */
        read(file: string, numbers: "array" | "typed"): Decoded[] {
            return Decoder({ numbers: numbers }).decode(new Uint8Array(readFileSync(file))).events
        },
    }
}

export type RingT = ReturnType<typeof Ring>
