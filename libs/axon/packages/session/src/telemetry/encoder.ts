import { BLOCK_LEAST, INTERN_MOST, MAGIC, MOST_DECIMALS, OP, TAG, TYPED, VERSION, WIDTH, type Envelope } from "./format"

/**
 * Encoder — envelopes into segment bytes (see format.ts). Holds the current
 * segment's string table; `begin()` starts a new segment and a new table.
 */
export function Encoder() {
    const text = new TextEncoder()
    let strings = new Map<string, number>()
    /** Encoded records not yet taken. */
    const out = Bytes(64 * 1024)
    /** One event's body while it is encoded — string definitions go to `out` ahead of it. */
    const body = Bytes(16 * 1024)

    function ref(value: string): number {
        let id = strings.get(value)
        if (id !== undefined) return id
        id = strings.size
        strings.set(value, id)
        const encoded = text.encode(value)
        out.u32(1 + 4 + 4 + encoded.length)
        out.u8(OP.string)
        out.u32(id)
        out.u32(encoded.length)
        out.raw(encoded)
        return id
    }

    function string(value: string): void {
        if (value.length <= INTERN_MOST) {
            body.u8(TAG.ref)
            body.u32(ref(value))
            return
        }
        const encoded = text.encode(value)
        body.u8(TAG.text)
        body.u32(encoded.length)
        body.raw(encoded)
    }

    function number(value: number): void {
        if (Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff) {
            body.u8(TAG.int)
            body.i32(value)
        } else {
            body.u8(TAG.float)
            body.f64(value)
        }
    }

    /**
     * A number array as one block, when it is all numbers and long enough
     * to be worth it: the coarsest exact scale (format.ts WIDTH), tried from
     * whole numbers up. A value that fits no scale ends the search at its
     * first element, so data with no scale costs one short pass per try.
     */
    function block(list: readonly unknown[]): boolean {
        if (list.length < BLOCK_LEAST) return false
        for (let index = 0; index < list.length; index++) if (typeof list[index] !== "number") return false
        const numbers = list as readonly number[]

        for (let decimals = 0; decimals <= MOST_DECIMALS; decimals++) {
            const scale = 10 ** decimals
            let low = Infinity
            let high = -Infinity
            let exact = true
            for (let index = 0; index < numbers.length; index++) {
                const scaled = Math.round(numbers[index]! * scale)
                if (scaled / scale !== numbers[index]) {
                    exact = false
                    break
                }
                if (scaled < low) low = scaled
                if (scaled > high) high = scaled
            }
            if (!exact) continue
            if (low < -0x80000000 || high > 0x7fffffff) break
            const width = low >= 0 && high <= 255 ? WIDTH.u8 : low >= -0x8000 && high <= 0x7fff ? WIDTH.i16 : WIDTH.i32
            body.u8(TAG.numbers)
            body.u8(width)
            body.u8(decimals)
            body.u32(numbers.length)
            body.reserve(numbers.length * (width === WIDTH.u8 ? 1 : width === WIDTH.i16 ? 2 : 4))
            for (let index = 0; index < numbers.length; index++) {
                const scaled = Math.round(numbers[index]! * scale)
                if (width === WIDTH.u8) body.u8(scaled)
                else if (width === WIDTH.i16) body.i16(scaled)
                else body.i32(scaled)
            }
            return true
        }

        body.u8(TAG.numbers)
        body.u8(WIDTH.f64)
        body.u8(0)
        body.u32(numbers.length)
        body.reserve(numbers.length * 8)
        for (let index = 0; index < numbers.length; index++) body.f64(numbers[index]!)
        return true
    }

    function value(item: unknown): void {
        if (item === null) return body.u8(TAG.null)
        switch (typeof item) {
            case "undefined":
            case "function":
            case "symbol":
                return body.u8(TAG.undefined)
            case "boolean":
                return body.u8(item ? TAG.true : TAG.false)
            case "number":
                return number(item)
            case "string":
                return string(item)
            case "bigint":
                throw new TypeError("telemetry cannot encode a bigint — neither can the log")
        }
        if (ArrayBuffer.isView(item) && !(item instanceof DataView)) {
            const kind = TYPED.findIndex(constructor => item instanceof constructor)
            if (kind < 0) throw new TypeError(`telemetry cannot encode a ${item.constructor.name}`)
            const bytes = new Uint8Array(item.buffer, item.byteOffset, item.byteLength)
            body.u8(TAG.typed)
            body.u8(kind)
            body.u32(bytes.length)
            body.raw(bytes)
            return
        }
        const toJSON = (item as { toJSON?: unknown }).toJSON
        if (typeof toJSON === "function") return value(toJSON.call(item))
        if (Array.isArray(item)) {
            if (block(item)) return
            body.u8(TAG.array)
            body.u32(item.length)
            for (const member of item) value(member === undefined || typeof member === "function" ? null : member)
            return
        }
        // One pass: the member count is written after the members, into
        // the slot reserved for it — JSON's dropped members (undefined,
        // functions) are only known once each is looked at.
        const record = item as Record<string, unknown>
        body.u8(TAG.object)
        const slot = body.length
        body.u32(0)
        let count = 0
        for (const key in record) {
            if (!Object.hasOwn(record, key)) continue
            const member = record[key]
            if (member === undefined || typeof member === "function" || typeof member === "symbol") continue
            body.u32(ref(key))
            value(member)
            count++
        }
        body.patch(slot, count)
    }

    return {
        /** Start a segment: the header, and an empty string table. Whatever was not taken is discarded. */
        begin(): void {
            strings = new Map()
            out.clear()
            out.u32(MAGIC)
            out.u16(VERSION)
            out.u16(0)
        },

        /** Encode one envelope after whatever is waiting to be taken. */
        encode(event: Envelope): void {
            body.clear()
            const { type, time, ...rest } = event
            body.u8(OP.event)
            body.u32(time.seq)
            body.f64(time.ms)
            body.u32(ref(type))
            value(rest)
            out.u32(body.length)
            out.raw(body.view())
        },

        /** Bytes waiting to be written. */
        get pending(): number {
            return out.length
        },

        /** Everything encoded since the last take, as a copy the caller owns. */
        take(): Uint8Array {
            const taken = out.view().slice()
            out.clear()
            return taken
        },
    }
}

export type EncoderT = ReturnType<typeof Encoder>

/** A growable byte buffer, little-endian. */
function Bytes(initial: number) {
    let buffer = new Uint8Array(initial)
    let view = new DataView(buffer.buffer)
    let length = 0

    function reserve(more: number): void {
        if (length + more <= buffer.length) return
        let size = buffer.length * 2
        while (size < length + more) size *= 2
        const grown = new Uint8Array(size)
        grown.set(buffer.subarray(0, length))
        buffer = grown
        view = new DataView(buffer.buffer)
    }

    return {
        get length(): number { return length },
        reserve: reserve,
        clear(): void { length = 0 },
        view(): Uint8Array { return buffer.subarray(0, length) },
        u8(value: number): void { reserve(1); buffer[length++] = value },
        u16(value: number): void { reserve(2); view.setUint16(length, value, true); length += 2 },
        u32(value: number): void { reserve(4); view.setUint32(length, value, true); length += 4 },
        /** Overwrite a u32 written earlier, at `at`. */
        patch(at: number, value: number): void { view.setUint32(at, value, true) },
        i16(value: number): void { reserve(2); view.setInt16(length, value, true); length += 2 },
        i32(value: number): void { reserve(4); view.setInt32(length, value, true); length += 4 },
        f64(value: number): void { reserve(8); view.setFloat64(length, value, true); length += 8 },
        raw(bytes: Uint8Array): void { reserve(bytes.length); buffer.set(bytes, length); length += bytes.length },
    }
}
