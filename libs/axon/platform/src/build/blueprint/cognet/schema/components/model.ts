import { err } from "@arcforge/err"

export type Field = { name: string; type: string; optional: boolean; nullable?: boolean }
export type Shape = { name: string; fields: Field[]; component: boolean; alias?: string; doc?: string; handle?: true }
/** What a method answers: a named type, fields written inline, or nothing. */
export type Answer = { named: string } | { inline: Field[] } | null
/** One method of an interface. `describe` is the provider reporting itself — every interface has one. */
export type Method = { name: string; doc?: string; params: Field[]; kind: "describe" | "call" | "stream" | "session"; answer: Answer; push?: string }
/** An interface's contract: the one exported interface in its file with methods. */
export type Contract = { name: string; doc?: string; methods: Method[] }
export type Import = { path: string; name: string }
export type File = { absPath: string; relPath: string; named: string; package: string; shapes: Shape[]; imports: Record<string, Import> }

/** Validate a parser process's JSON before the schema compiler trusts it. */
export function parseShapes(path: string, output: string): Shape[] {
    let value: unknown
    try { value = JSON.parse(output) }
    catch { fail(path, "component parser returned invalid JSON") }
    if (!Array.isArray(value)) fail(path, "component parser returned no declaration list")
    return value.map((shape: unknown) => {
        if (!record(shape) || typeof shape.name !== "string" || typeof shape.component !== "boolean" || !Array.isArray(shape.fields) || (shape.doc !== undefined && shape.doc !== null && typeof shape.doc !== "string")) fail(path, "component parser returned an invalid declaration")
        const fields = shape.fields.map((field: unknown) => {
            if (!record(field) || typeof field.name !== "string" || typeof field.type !== "string" || typeof field.optional !== "boolean" || (field.nullable !== undefined && typeof field.nullable !== "boolean")) fail(path, `${shape.name}: parser returned an invalid field`)
            return { name: field.name, type: field.type, optional: field.optional, nullable: field.nullable }
        })
        return { name: shape.name, fields: fields, component: shape.component, doc: shape.doc ?? undefined }
    })
}

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value) }

export function fail(file: string, detail: string): never {
    throw err("COGNET_SCHEMA_INVALID", { detail: `${file}: ${detail}` })
}
