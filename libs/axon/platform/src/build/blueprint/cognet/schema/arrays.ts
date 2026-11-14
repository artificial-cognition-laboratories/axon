import { ScalarType, type DescField } from "@bufbuild/protobuf"
import { err } from "@arcforge/err"

/**
 * What a `(cognet.array)` field of each number type is held as, in every
 * language — one row a type, read by both emitters, so a block of memory is
 * the same block on either side of the boundary.
 */
export const ARRAYS: ReadonlyMap<ScalarType, { typescript: string; rust: string }> = new Map([
    [ScalarType.DOUBLE, { typescript: "Float64Array", rust: "f64" }],
    [ScalarType.FLOAT, { typescript: "Float32Array", rust: "f32" }],
    [ScalarType.INT32, { typescript: "Int32Array", rust: "i32" }],
    [ScalarType.UINT32, { typescript: "Uint32Array", rust: "u32" }],
])

/** The row for a `(cognet.array)` field — which must be a plain repeated number of one of these types. */
export function arrayOf(field: DescField, fixed: number): { typescript: string; rust: string } {
    const found = field.fieldKind === "list" && field.listKind === "scalar" ? ARRAYS.get(field.scalar) : undefined
    const where = `${field.parent.file.name}.proto, ${field.parent.name}.${field.name}`
    if (!found) throw err("COGNET_SCHEMA_INVALID", { detail: `${where}: (cognet.array) is for a repeated double, float, int32 or uint32` })
    if (fixed > 0) throw err("COGNET_SCHEMA_INVALID", { detail: `${where}: a field is (cognet.array) — a block of any length — or (cognet.fixed), not both` })
    return found
}
