import { HEADER_BYTES, MAGIC, OP, TAG, TYPED, VERSION, WIDTH, type Decoded } from "./format"

export type DecoderOpts = {
    /**
     * How a block of numbers reads back. `"array"`: a plain array, exactly
     * what the log would have given. `"typed"`: the typed array itself —
     * what a reader that hands fields on as typed arrays wants.
     */
    numbers: "array" | "typed"
}

/**
 * Decoder — one segment's reader. Feed it the segment's bytes from the
 * start, in pieces as they arrive; it returns every complete event and how
 * many bytes it used, and expects the rest again next time.
 */
export function Decoder(opts: DecoderOpts) {
    const text = new TextDecoder()
    const strings: string[] = []
    let started = false

    return {
        decode(bytes: Uint8Array): { events: Decoded[]; used: number } {
            const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
            const events: Decoded[] = []
            let at = 0

            if (!started) {
                if (bytes.length < HEADER_BYTES) return { events: events, used: 0 }
                if (view.getUint32(0, true) !== MAGIC) throw new Error("not a telemetry segment: bad magic")
                const version = view.getUint16(4, true)
                if (version !== VERSION) throw new Error(`telemetry segment version ${version}; this reader knows ${VERSION}`)
                started = true
                at = HEADER_BYTES
            }

            while (at + 4 <= bytes.length) {
                const length = view.getUint32(at, true)
                if (at + 4 + length > bytes.length) break
                const start = at + 4
                const op = bytes[start]
                if (op === OP.string) {
                    const id = view.getUint32(start + 1, true)
                    const size = view.getUint32(start + 5, true)
                    strings[id] = text.decode(bytes.subarray(start + 9, start + 9 + size))
                } else if (op === OP.event) {
                    const reader = Reader(bytes, view, start + 1, strings, text, opts.numbers)
                    const seq = reader.u32()
                    const ms = reader.f64()
                    const type = strings[reader.u32()]
                    if (type === undefined) throw new Error(`telemetry record at byte ${at} names a string this segment never defined`)
                    const rest = reader.value() as Record<string, unknown>
                    events.push({ type: type, time: { ms: ms, seq: seq }, ...rest })
                } else {
                    throw new Error(`telemetry record at byte ${at} has unknown op ${op}`)
                }
                at = start + length
            }
            return { events: events, used: at }
        },
    }
}

export type DecoderT = ReturnType<typeof Decoder>

/** Reads one event's value, from `at`. */
function Reader(bytes: Uint8Array, view: DataView, start: number, strings: string[], text: TextDecoder, numbers: DecoderOpts["numbers"]) {
    let at = start

    function u32(): number { const value = view.getUint32(at, true); at += 4; return value }
    function f64(): number { const value = view.getFloat64(at, true); at += 8; return value }

    /**
     * One block of numbers, copied out so the view is aligned and outlives
     * the segment buffer. Scaled blocks read back as float64 — k / 10^d is
     * exactly the value that was written.
     */
    function block(): ArrayLike<number> | number[] {
        const width = bytes[at++]!
        const decimals = bytes[at++]!
        const count = u32()
        const size = width === WIDTH.u8 ? 1 : width === WIDTH.i16 ? 2 : width === WIDTH.i32 ? 4 : 8
        const copy = own(bytes, at, count * size)
        at += count * size
        let typed: Uint8Array | Int16Array | Int32Array | Float64Array =
            width === WIDTH.u8 ? new Uint8Array(copy)
                : width === WIDTH.i16 ? new Int16Array(copy)
                    : width === WIDTH.i32 ? new Int32Array(copy)
                        : new Float64Array(copy)
        if (decimals > 0) {
            const scale = 10 ** decimals
            const scaled = new Float64Array(count)
            for (let index = 0; index < count; index++) scaled[index] = typed[index]! / scale
            typed = scaled
        }
        return numbers === "typed" ? typed : Array.from(typed)
    }

    function name(id: number): string {
        const found = strings[id]
        if (found === undefined) throw new Error(`telemetry value names string ${id}, which this segment never defined`)
        return found
    }

    function value(): unknown {
        const tag = bytes[at++]
        switch (tag) {
            case TAG.null: return null
            case TAG.undefined: return undefined
            case TAG.false: return false
            case TAG.true: return true
            case TAG.int: { const number = view.getInt32(at, true); at += 4; return number }
            case TAG.float: return f64()
            case TAG.ref: return name(u32())
            case TAG.text: {
                const size = u32()
                const decoded = text.decode(bytes.subarray(at, at + size))
                at += size
                return decoded
            }
            case TAG.array: {
                const count = u32()
                const list = new Array<unknown>(count)
                for (let index = 0; index < count; index++) list[index] = value()
                return list
            }
            case TAG.object: {
                const count = u32()
                const record: Record<string, unknown> = {}
                for (let index = 0; index < count; index++) {
                    const key = name(u32())
                    record[key] = value()
                }
                return record
            }
            case TAG.numbers: return block()
            case TAG.typed: {
                const kind = TYPED[bytes[at++]!]
                if (!kind) throw new Error("telemetry value has an unknown typed array kind")
                const size = u32()
                const copy = own(bytes, at, size)
                at += size
                return new kind(copy)
            }
        }
        throw new Error(`telemetry value has unknown tag ${tag} at byte ${at - 1}`)
    }

    return { u32: u32, f64: f64, value: value }
}

/**
 * `length` bytes from `at`, in a buffer of their own. Not `slice`: a Node
 * Buffer's slice is a VIEW into a shared pool, whose `.buffer` is the whole
 * pool at an arbitrary offset — an Int16Array over it fails, or worse, reads
 * the wrong bytes. A fresh buffer is always aligned and owned.
 */
function own(bytes: Uint8Array, at: number, length: number): ArrayBuffer {
    const copy = new Uint8Array(length)
    copy.set(bytes.subarray(at, at + length))
    return copy.buffer
}
