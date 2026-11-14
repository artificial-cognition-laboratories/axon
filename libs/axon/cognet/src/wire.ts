import { err } from "@arcforge/err"

/** Values with typed arrays lifted out: the JSON with `{"$array": i}` in each one's place, and each array's bytes and kind. */
export type Packed = { json: string; kinds: string[]; arrays: Uint8Array[] }

/** The name each typed array's kind crosses as — the `cognet` crate's `Block`, the Python runtime's `KIND`. */
const KINDS = new Map<unknown, string>([[Float64Array, "f64"], [Float32Array, "f32"], [Int32Array, "i32"], [Uint32Array, "u32"], [Uint8Array, "u8"]])

/** The typed array each kind is read back as, and how many bytes one element is. */
const VIEWS: Record<string, { make(buffer: ArrayBuffer): ArrayBufferView; size: number }> = {
    f64: { make: buffer => new Float64Array(buffer), size: 8 },
    f32: { make: buffer => new Float32Array(buffer), size: 4 },
    i32: { make: buffer => new Int32Array(buffer), size: 4 },
    u32: { make: buffer => new Uint32Array(buffer), size: 4 },
    u8: { make: buffer => new Uint8Array(buffer), size: 1 },
}

/**
 * Wire — values crossing to a Rust or Python system and back. Every typed
 * array in a value crosses as its bytes, a marker left in its place: one copy
 * of the memory however many numbers it holds, where JSON would write each one
 * out as text. The same for a snapshot, a reply, a kernel call and its answer.
 */
export const wire = {
    /** `value` as JSON, its arrays lifted out. `who` names what is crossing, for a refusal. */
    pack(value: unknown, who: string): Packed {
        const into: Packed = { json: "", kinds: [], arrays: [] }
        into.json = JSON.stringify(wire.lift(value, into, who))
        return into
    },

    /** JSON back into a value, each marker replaced by the array it names. */
    unpack(json: string, arrays: readonly ArrayBufferView[], who: string): unknown {
        return JSON.parse(json, arrays.length === 0 ? undefined : (_key, value: unknown) => {
            if (!wire.marker(value)) return value
            const array = arrays[value.$array]
            if (!array) throw invalid(`${who} marked array ${value.$array} of the ${arrays.length} it sent`)
            return array
        })
    },

    /**
     * `value` with every typed array in it replaced by its marker, the array
     * lifted into `into`. Walks the structure only: a list of numbers or
     * strings is taken whole — a schema's list holds one type, so nothing in
     * it can be a block — and `JSON.stringify` then writes it without calling
     * back here for each of its thousands of numbers.
     */
    lift(value: unknown, into: Omit<Packed, "json">, who: string): unknown {
        if (typeof value !== "object" || value === null) return value
        if (ArrayBuffer.isView(value)) {
            const kind = KINDS.get(value.constructor)
            if (!kind) throw invalid(`${who} holds a ${value.constructor.name}, which no schema declares — a block is a Float64Array, Float32Array, Int32Array, Uint32Array or Uint8Array`)
            into.arrays.push(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
            into.kinds.push(kind)
            return { $array: into.arrays.length - 1 }
        }
        if (Array.isArray(value)) {
            const first: unknown = value[0]
            if (typeof first !== "object" || first === null) return value
            return value.map(one => wire.lift(one, into, who))
        }
        const out: Record<string, unknown> = {}
        for (const key in value) out[key] = wire.lift(Reflect.get(value, key), into, who)
        return out
    },

    /** Arrays sent as base64, as a process sends them: each read back as its kind, its length checked. */
    decoded(kinds: readonly string[], encoded: readonly string[], who: string): ArrayBufferView[] {
        if (kinds.length !== encoded.length) throw invalid(`${who} sent ${kinds.length} kinds for ${encoded.length} arrays`)
        return encoded.map((text, at) => {
            if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) throw invalid(`${who}'s array ${at} is not base64`)
            const view = VIEWS[kinds[at]!]
            if (!view) throw invalid(`${who}'s array ${at} is of unknown kind ${kinds[at]}`)
            const copy = Uint8Array.from(Buffer.from(text, "base64"))
            if (copy.byteLength % view.size !== 0) throw invalid(`${who}'s array ${at} is not aligned for ${kinds[at]}`)
            return view.make(copy.buffer)
        })
    },

    /** Arrays as base64, as a process is sent them. */
    encoded(arrays: readonly Uint8Array[]): string[] {
        return arrays.map(array => Buffer.from(array).toString("base64"))
    },

    marker(value: unknown): value is { $array: number } {
        return typeof value === "object" && value !== null && "$array" in value && typeof value.$array === "number" && Object.keys(value).length === 1
    },
}

function invalid(why: string): Error {
    return err("COGNET_DISCOVERY_INVALID", { detail: `a value crossing to or from a Rust or Python system is not what this runtime expects: ${why}` })
}
