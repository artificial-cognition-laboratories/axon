import { readFileSync } from "node:fs"
import { dirname } from "node:path"
import type { Source } from "../compile"
import { external, type External } from "./external"
import { fail, type Field, type File, type Shape } from "./model"
import { Lock } from "./lock"
import { typescript } from "./typescript"
import { PythonSource } from "./python"
import { RustSource } from "./rust"
import { said, type Said } from "./tags"

/** Native component sources compiled to the same protobuf image as the legacy schemas. */
export function Components(opts: { root: string; files: readonly { absPath: string; relPath: string }[]; legacy: readonly Source[] }) {
    // Beside the source and committed, as Cargo.lock is: a field's number is its identity in every recorded session.
    const lock = Lock({ path: `${opts.root}/components.lock.json` })
    const python = PythonSource({})
    const rust = RustSource({})
    return {
        /** The proto for every component file, and the files as read — which interfaces resolve their value types against. */
        sources(): { sources: Source[]; files: File[] } {
            const files = opts.files.flatMap(file => {
                const ext = file.relPath.match(/\.components\.(ts|rs|py)$/)?.[1]
                if (!ext) fail(file.absPath, "expected a *.components.ts, *.components.rs or *.components.py file")
                const named = file.relPath.replace(/^(types|src)\//, "").replace(/\.components\.(ts|rs|py)$/, `.$1-components.proto`)
                const packageName = `cognet_source.${named.slice(0, -6).split("/").map(segment => segment.replace(/[^A-Za-z0-9_]/g, "_").replace(/^(?=\d)/, "_")).join(".")}`
                const parsed = ext === "ts" ? typescript(file.absPath, readFileSync(file.absPath, "utf8")) : { shapes: ext === "py" ? python.read(file.absPath) : rust.read(file.absPath), imports: {} }
                // Declares nothing yet: a file being started, not a mistake. Declaring types and exporting none is.
                if (parsed.shapes.length === 0) return []
                const told = new Map(parsed.shapes.map(shape => [shape.name, said(file.absPath, shape)]))
                // A frame is an export that says `@space`: it holds no value, so it is no component and no message.
                const shapes = parsed.shapes.map(shape => ({ ...shape, doc: told.get(shape.name)!.doc, component: shape.component && !told.get(shape.name)!.space }))
                for (const shape of shapes.filter(shape => told.get(shape.name)!.space)) {
                    if (!parsed.shapes.find(one => one.name === shape.name)!.component) fail(file.absPath, `${shape.name}: a frame is exported`)
                    if (shape.fields.length || shape.alias) fail(file.absPath, `${shape.name}: a frame holds no fields — it is a space, not a value`)
                }
                if (!shapes.some(shape => shape.component || told.get(shape.name)!.space)) fail(file.absPath, "a component file must export at least one component or frame")
                return [{ ...file, named: named, package: packageName, shapes: shapes, imports: parsed.imports, said: told }]
            })
            const names = new Map<string, { file: File; shape: Shape }>()
            for (const file of files) for (const shape of file.shapes.filter(shape => shape.component)) {
                if (shape.name === "Components" || shape.name === "Frames") fail(file.absPath, `${shape.name} is reserved for a generated container`)
                if (!/^[A-Z][A-Za-z0-9]*$/.test(shape.name)) fail(file.absPath, `${shape.name}: component type names must be PascalCase`)
                const name = fullName(file.named, componentName(shape.name))
                const existing = names.get(name)
                if (existing) fail(file.absPath, `component ${shape.name} overlaps ${existing.shape.name} in ${existing.file.relPath}; every component has one owning definition`)
                names.set(name, { file: file, shape: shape })
            }
            const shapes = new Map<string, Array<{ file: File; shape: Shape }>>()
            for (const file of files) for (const shape of file.shapes) {
                const owners = shapes.get(shape.name) ?? []
                owners.push({ file: file, shape: shape })
                shapes.set(shape.name, owners)
            }
            const existing = files.length ? external(opts.legacy) : []
            const resolve = (file: File, name: string): string => {
                const local = file.shapes.find(shape => shape.name === name)
                if (local) return local.name
                const imported = file.imports[name]
                if (imported) {
                    const nativeFile = files.find(one => one.absPath === imported.path)
                    const native = nativeFile?.shapes.find(shape => shape.name === imported.name)
                    if (nativeFile && native) return `.${nativeFile.package}.${native.name}`
                    const legacy = existing.find(one => one.absPath === imported.path && one.name === imported.name)
                    if (legacy) return `.${legacy.package}.${legacy.name}`
                    fail(file.absPath, `${name}: import ${imported.path} does not name a known schema type`)
                }
                const owners = shapes.get(name) ?? []
                const legacy = existing.filter(one => one.name === name)
                if (owners.length + legacy.length !== 1) fail(file.absPath, `${name} refers to ${owners.length + legacy.length === 0 ? "no component or known value type" : "more than one type"}; use a unique name`)
                return owners.length ? `.${owners[0]!.file.package}.${name}` : `.${legacy[0]!.package}.${name}`
            }
            const sources = files.map(file => ({ absPath: file.absPath, named: file.named, content: emit(file, files, existing, lock, resolve) }))
            const active = files.flatMap(file => [...file.shapes.map(shape => owner(file, shape)), `${file.named}/Components`, `${file.named}/Frames`])
            lock.finishAll(active)
            return { sources: sources, files: files }
        },
        save(): void { lock.save() },
    }
}

/** A component file as read: its shapes, and what each one's doc said. */
type Read = File & { said: Map<string, Said> }

function emit(file: Read, files: File[], existing: External[], lock: ReturnType<typeof Lock>, resolve: (file: File, name: string) => string): string {
    const imports = new Set<string>()
    const blocks: string[] = []
    /** Each container field's comment and options — what the component or frame is, beyond its type. */
    type Member = { doc?: string; options: string[] }
    const emitMessage = (shape: Shape, container: "components" | "frames" | null, members: Map<string, Member> = new Map()): void => {
        const identity = owner(file, shape)
        const fields = shape.fields.map(field => {
            const fieldName = protoName(field.name)
            const type = container === "frames" ? { proto: "cognet.Frame", repeated: false, options: [] } : fieldType(field.type, file, resolve)
            const member = members.get(field.name)
            if (field.nullable && type.repeated) fail(file.absPath, `${shape.name}.${field.name}: nullable lists and maps are not supported`)
            if (type.reference?.startsWith(".")) {
                const foreign = files.find(one => type.reference!.startsWith(`.${one.package}.`)) ?? existing.find(one => type.reference === `.${one.package}.${one.name}`)
                if (!foreign) fail(file.absPath, `${shape.name}.${field.name}: ${type.reference} has no source`)
                if (foreign !== file) imports.add(foreign.named)
            }
            const signature = `${type.proto}|${field.optional}|${!!field.nullable}|${type.options.join(",")}`
            const number = lock.field(identity, fieldName, signature)
            const options = [...type.options, ...member?.options ?? []]
            if (field.optional && type.repeated) options.push("(cognet.optional) = true")
            if (field.nullable) options.push("(cognet.nullable) = true")
            const option = options.length ? ` [${options.join(", ")}]` : ""
            const comment = member?.doc ? member.doc.split("\n").map(line => `  // ${line}`) : []
            return [...comment, `  ${field.optional && !type.repeated ? "optional " : ""}${type.proto} ${fieldName} = ${number}${option};`].join("\n")
        })
        const removed = lock.finish(identity, shape.fields.map(field => protoName(field.name)))
        const reserved = removed.length ? [`  reserved ${removed.join(", ")};`] : []
        blocks.push(...(shape.doc ? shape.doc.split("\n").map(line => `// ${line}`) : []), `message ${shape.name} {`, ...(container ? [`  option (cognet.${container}) = true;`] : []), ...reserved, ...fields, "}", "")
    }
    const spaces = new Map([...file.said].filter(([, told]) => told.space).map(([name, told]) => [name, told.space!]))
    for (const shape of file.shapes) if (!shape.alias && !spaces.has(shape.name)) emitMessage(shape, null)
    const components = file.shapes.filter(shape => shape.component)
    for (const shape of components.filter(shape => shape.alias)) {
        const type = fieldType(shape.alias!, file, resolve)
        lock.field(owner(file, shape), "value", `${type.proto}|${type.options.join(",")}`)
        lock.finish(owner(file, shape), ["value"])
    }
    const componentFields = components.map(shape => ({ name: componentName(shape.name), type: shape.alias ?? shape.name, optional: false }))
    // Frames first: the components after them are drawn in them.
    if (spaces.size) {
        const frames = file.shapes.filter(shape => spaces.has(shape.name))
        const frameMembers = new Map(frames.map(shape => [componentName(shape.name), { doc: shape.doc, options: [`(cognet.frame) = { kind: ${kind(file, shape.name, spaces.get(shape.name)!)} }`] }]))
        emitMessage({ name: "Frames", fields: frames.map(shape => ({ name: componentName(shape.name), type: "Frame", optional: false })), component: false }, "frames", frameMembers)
    }
    const componentMembers = new Map(components.map(shape => [componentName(shape.name), { doc: shape.doc, options: display(file, shape, spaces) }]))
    emitMessage({ name: "Components", fields: componentFields, component: false }, "components", componentMembers)
    const head = [
        `// Generated by axon prepare from ${file.relPath}.`,
        'syntax = "proto3";',
        `package ${file.package};`,
        'import "cognet/cognet.proto";',
        ...[...imports].sort().map(name => `import ${JSON.stringify(name)};`),
        "",
    ]
    return [...head, ...blocks].join("\n")
}

/**
 * A component's display option: what its doc wrote, and what the type implies
 * for the rest — a number is a scalar, a word categorical, a list a vector,
 * anything with fields a record; indexed by its frame's space, or by nothing
 * when it has no frame.
 */
function display(file: Read, shape: Shape, spaces: Map<string, string>): string[] {
    const told = file.said.get(shape.name)!
    const written = told.display
    const frame = told.frame
    const local = frame ? [...spaces].find(([name]) => componentName(name) === frame)?.[1] : undefined
    const domain = !frame ? "POINT" : local === "sequence" ? "SEQUENCE" : local === "tree" ? "TREE" : local === "graph" ? "SET" : "SPACE"
    const type = shape.alias?.trim()
    const form = !type ? "RECORD" : ["number", "f64", "f32", "u32", "i32"].includes(type) ? "SCALAR" : ["string", "boolean"].includes(type) ? "CATEGORICAL" : /^(Fixed<|Vec<|Array<|Float|Int|Uint)/.test(type) ? "VECTOR" : "RECORD"
    const options = { domain: `DOMAIN_${domain}`, shape: `SHAPE_${form}`, ...written }
    return [`(cognet.component) = { display: { ${Object.entries(options).map(([key, value]) => `${key}: ${value}`).join(", ")} } }`]
}

/** A frame's space kind, as protobuf names it. */
function kind(file: Read, name: string, space: string): string {
    const known = ["metric2d", "metric3d", "graph", "tree", "sequence"]
    if (!known.includes(space)) fail(file.absPath, `${name}: @space is one of ${known.join(", ")}, not ${space}`)
    return `KIND_${space.toUpperCase()}`
}

export function protoName(name: string): string { return name.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2").replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase() }
function componentName(name: string): string { return protoName(name).replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()) }
function fullName(named: string, name: string): string { const folder = dirname(named); return folder === "." ? name : `${folder}/${name}` }
function owner(file: File, shape: Shape): string { return shape.component ? `component/${fullName(file.named, componentName(shape.name))}` : `${file.named}/${shape.name}` }

export function fieldType(raw: string, file: File, resolve: (file: File, name: string) => string): { proto: string; reference?: string; repeated: boolean; options: string[] } {
    const type = raw.trim()
    const scalar: Record<string, string> = { number: "double", f64: "double", f32: "float", u32: "uint32", i32: "int32", string: "string", boolean: "bool", bytes: "bytes" }
    if (scalar[type]) return { proto: scalar[type], repeated: false, options: [] }
    const arrays: Record<string, string> = { Float32Array: "float", Float64Array: "double", Int32Array: "int32", Uint32Array: "uint32", Uint8Array: "bytes" }
    if (arrays[type]) return { proto: `${type === "Uint8Array" ? "" : "repeated "}${arrays[type]}`, repeated: type !== "Uint8Array", options: type === "Uint8Array" ? [] : ["(cognet.array) = true"] }
    if (type === "Vec<u8>") return { proto: "bytes", repeated: false, options: [] }
    const fixed = type.match(/^Fixed<(.+),(\d+)>$/)
    if (fixed) {
        const length = Number(fixed[2])
        if (!Number.isSafeInteger(length) || length < 1 || length > 1024) fail(file.absPath, `${type}: fixed tuple length must be 1..1024`)
        const inner = fieldType(fixed[1]!, file, resolve)
        if (inner.repeated || inner.proto.startsWith("map<")) fail(file.absPath, `${type}: fixed tuple elements cannot be collections`)
        return { proto: `repeated ${inner.proto}`, reference: inner.reference, repeated: true, options: [...inner.options, `(cognet.fixed) = ${length}`] }
    }
    const list = type.match(/^(?:Vec|Array|list)<(.+)>$/) ?? type.match(/^(.+)\[\]$/)
    if (list) {
        const inner = fieldType(list[1]!, file, resolve)
        if (inner.repeated || inner.proto.startsWith("map<")) fail(file.absPath, `${type}: nested collections are not supported`)
        return { proto: `repeated ${inner.proto}`, reference: inner.reference, repeated: true, options: inner.options }
    }
    const map = type.match(/^(?:Record|BTreeMap|HashMap|dict)<(.+)>$/)
    if (map) {
        const parts = split(map[1]!)
        if (parts.length !== 2) fail(file.absPath, `${type}: expected a map key and value`)
        const inner = fieldType(parts[1]!, file, resolve)
        if (inner.repeated || inner.proto.startsWith("map<")) fail(file.absPath, `${type}: map values cannot be collections`)
        const key = parts[0]!
        const scalarKey = key === "string" ? "string" : key === "u32" ? "uint32" : key === "i32" ? "int32" : null
        const namedKey = scalarKey ? null : resolve(file, key)
        return { proto: `map<${scalarKey ?? "string"}, ${inner.proto}>`, reference: inner.reference, repeated: true, options: namedKey ? [`(cognet.keys) = ${JSON.stringify(namedKey.replace(/^\./, ""))}`] : [] }
    }
    if (!/^[A-Za-z_]\w*$/.test(type)) fail(file.absPath, `unsupported component field type ${type}`)
    const reference = resolve(file, type)
    return { proto: reference, reference: reference, repeated: false, options: [] }
}

function split(input: string): string[] {
    let depth = 0
    const parts: string[] = []
    let start = 0
    for (let index = 0; index < input.length; index++) {
        if (input[index] === "<") depth++
        if (input[index] === ">") depth--
        if (input[index] === "," && depth === 0) { parts.push(input.slice(start, index).trim()); start = index + 1 }
    }
    parts.push(input.slice(start).trim())
    return parts
}
