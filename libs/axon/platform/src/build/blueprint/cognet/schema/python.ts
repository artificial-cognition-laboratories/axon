import { getOption, ScalarType, type DescEnum, type DescField, type DescFile, type DescMessage, type FileRegistry } from "@bufbuild/protobuf"
import { err } from "@arcforge/err"
import { rust } from "./rust"

const KEYWORDS = new Set(["False", "None", "True", "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del", "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try", "while", "with", "yield"])

/** Python schema modules and editor stubs from the same descriptor image as Rust. */
export const python = {
    files(files: readonly DescFile[], registry: FileRegistry): Array<[string, string]> {
        const components = registry.getExtension("cognet.components")
        const frames = registry.getExtension("cognet.frames")
        const union = registry.getExtension("cognet.union")
        const optional = registry.getExtension("cognet.optional")
        const nullable = registry.getExtension("cognet.nullable")
        const array = registry.getExtension("cognet.array")
        const fixed = registry.getExtension("cognet.fixed")
        const text = registry.getExtension("cognet.text")
        if (!components || !frames || !union || !optional || !nullable || !array || !fixed || !text) {
            throw err("COGNET_SCHEMA_INVALID", { detail: "the runtime is missing Python schema options" })
        }
        const generated: Array<[string, string]> = []
        const accessors: Array<{ name: string; type: string; path: string; field: DescField }> = []

        for (const file of files) {
            const path = file.name.replace(/\.proto$/, "").split("/").map(rust.segment).join("/")
            const module = `cognet_generated.schema.${path.replaceAll("/", ".")}`
            const imports = new Map<string, Set<string>>()
            const type = (field: DescField): string => {
                if (getOption(field, array) === true) return "array.array"
                const named = (desc: DescMessage | DescEnum): string => {
                    const name = local(desc)
                    if (desc.file === file) return name
                    const foreign = `cognet_generated.schema.${desc.file.name.replace(/\.proto$/, "").split("/").map(rust.segment).join(".")}`
                    const names = imports.get(foreign) ?? new Set<string>()
                    names.add(name)
                    imports.set(foreign, names)
                    return name
                }
                const scalar = (kind: ScalarType): string => {
                    switch (kind) {
                        case ScalarType.DOUBLE:
                        case ScalarType.FLOAT: return "float"
                        case ScalarType.INT32:
                        case ScalarType.SINT32:
                        case ScalarType.SFIXED32:
                        case ScalarType.UINT32:
                        case ScalarType.FIXED32: return "int"
                        case ScalarType.BOOL: return "bool"
                        case ScalarType.STRING: return "str"
                        case ScalarType.BYTES: return "array.array"
                        default: throw err("COGNET_SCHEMA_INVALID", { detail: `${file.name}.${field.name}: Python cannot represent a 64-bit integer in the cognet JSON contract` })
                    }
                }
                switch (field.fieldKind) {
                    case "scalar": return scalar(field.scalar)
                    case "enum": return named(field.enum)
                    case "message": return named(field.message)
                    case "list": {
                        const element = field.listKind === "scalar" ? scalar(field.scalar) : field.listKind === "enum" ? named(field.enum) : named(field.message)
                        const size = getOption(field, fixed)
                        return typeof size === "number" && size > 0 ? `tuple[${new Array<string>(size).fill(element).join(", ")}]` : `list[${element}]`
                    }
                    case "map": return `dict[${field.mapKey === ScalarType.STRING ? "str" : "int"}, ${field.mapKind === "scalar" ? scalar(field.scalar) : field.mapKind === "enum" ? named(field.enum) : named(field.message)}]`
                }
            }
            const lines: string[] = []
            const emitEnum = (desc: DescEnum): void => {
                const values = desc.values.filter(value => !(value.number === 0 && value.name.endsWith("_UNSPECIFIED")))
                lines.push(`class ${local(desc)}(str, Enum):`)
                for (const value of values) {
                    const prefix = `${desc.name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase()}_`
                    const rest = value.name.startsWith(prefix) ? value.name.slice(prefix.length) : value.name
                    const fallback = rest.toLowerCase().replace(/_([a-z0-9])/g, (_, next: string) => next.toUpperCase())
                    const valueText = getOption(value, text)
                    lines.push(`    ${value.name} = ${JSON.stringify(typeof valueText === "string" && valueText ? valueText : fallback)}`)
                }
                lines.push("")
            }
            const emitMessage = (desc: DescMessage): void => {
                for (const nested of desc.nestedEnums) emitEnum(nested)
                for (const nested of desc.nestedMessages) emitMessage(nested)
                if (getOption(desc, frames) === true) return
                if (getOption(desc, components) === true) {
                    for (const field of desc.fields) {
                        const name = `${file.name.includes("/") ? file.name.slice(0, file.name.lastIndexOf("/")) + "/" : ""}${field.jsonName}`
                        const owner = field.fieldKind === "message" ? field.message.file : field.fieldKind === "enum" ? field.enum.file : file
                        const ownerPath = owner.name.replace(/\.proto$/, "").split("/").map(rust.segment).join(".")
                        accessors.push({ name: name, type: type(field), path: `cognet_generated.schema.${ownerPath}`, field: field })
                    }
                    return
                }
                const tag = getOption(desc, union)
                if (typeof tag === "string" && tag) {
                    const variants: string[] = []
                    for (const field of desc.fields) {
                        if (field.fieldKind !== "message") throw err("COGNET_SCHEMA_INVALID", { detail: `${file.name}.${desc.name}: a Python union member must be a message` })
                        const variant = `${local(desc)}${field.jsonName[0]!.toUpperCase()}${field.jsonName.slice(1)}`
                        lines.push("@dataclass(kw_only=True, slots=True)", `class ${variant}:`, `    ${tag}: Literal[${JSON.stringify(field.jsonName)}] = ${JSON.stringify(field.jsonName)}`)
                        lines.push(...field.message.fields.map(member => emitField(member)))
                        lines.push("")
                        variants.push(variant)
                    }
                    lines.push(`${local(desc)} = ${variants.join(" | ")}`, "")
                    return
                }
                lines.push("@dataclass(kw_only=True, slots=True)", `class ${local(desc)}:`)
                if (desc.fields.length === 0) lines.push("    pass")
                lines.push(...desc.fields.map(field => emitField(field)))
                lines.push("")
            }
            const emitField = (field: DescField): string => {
                const absent = field.proto.proto3Optional || getOption(field, optional) === true
                const isNullable = getOption(field, nullable) === true
                const hint = `${type(field)}${isNullable ? " | None" : ""}${absent ? " | _Unset" : ""}`
                const name = KEYWORDS.has(field.jsonName) ? `${field.jsonName}_` : field.jsonName
                const metadata = name === field.jsonName ? "" : `metadata={"json": ${JSON.stringify(field.jsonName)}}`
                const suffix = absent ? ` = field(default=UNSET${metadata ? `, ${metadata}` : ""})` : metadata ? ` = field(${metadata})` : ""
                return `    ${name}: ${hint}${suffix}`
            }
            for (const value of file.enums) emitEnum(value)
            for (const value of file.messages) emitMessage(value)
            const head = [
                "# Generated by axon prepare from this cognet's component schema.",
                "from __future__ import annotations",
                "from dataclasses import dataclass, field",
                "from enum import Enum",
                "from typing import TYPE_CHECKING, Literal",
                "import array",
                "from cognet.runtime import UNSET, _Unset",
                "if TYPE_CHECKING:",
                ...([...imports].length ? [...imports].sort().map(([foreign, names]) => `    from ${foreign} import ${[...names].sort().join(", ")}`) : ["    pass"]),
                "",
            ]
            generated.push([`cognet_generated/schema/${path}.py`, [...head, ...lines].join("\n")])
        }

        const count = new Map<string, number>()
        for (const one of accessors) {
            const short = one.name.split("/").at(-1)!
            count.set(short, (count.get(short) ?? 0) + 1)
        }
        const unique = accessors.filter(one => count.get(one.name.split("/").at(-1)!) === 1)
        const modules = [...new Set(unique.filter(one => /^[A-Z][A-Za-z0-9_]*$/.test(one.type)).map(one => one.path))]
        const aliases = new Map(modules.map((module, index) => [module, `schema${index}`]))
        const hint = (one: typeof unique[number]): string => /^[A-Z][A-Za-z0-9_]*$/.test(one.type) ? `${aliases.get(one.path)}.${one.type}` : one.type.includes("[") && /[A-Z]/.test(one.type) ? "Any" : one.type
        const models = new Map(files.map((file, at) => [file, `model${at}`]))
        const model = (file: DescFile): string => {
            const found = models.get(file)
            if (!found) throw err("COGNET_SCHEMA_INVALID", { detail: `${file.name}: Python schema has no generated module` })
            return found
        }
        const messages: DescMessage[] = []
        const visit = (message: DescMessage): void => {
            for (const nested of message.nestedMessages) visit(nested)
            if (getOption(message, frames) !== true && getOption(message, components) !== true) messages.push(message)
        }
        for (const file of files) for (const message of file.messages) visit(message)
        const decoders = new Map(messages.map((message, at) => [message, `decode_${at}`]))
        const convert = (field: DescField, value: string): string => {
            const enumeration = (desc: DescEnum, input: string): string => {
                return `${model(desc.file)}.${local(desc)}(${input})`
            }
            const message = (desc: DescMessage, input: string): string => {
                const decoder = decoders.get(desc)
                if (!decoder) throw err("COGNET_SCHEMA_INVALID", { detail: `${desc.file.name}.${desc.name}: Python has no value decoder` })
                return `${decoder}(${input})`
            }
            let result: string
            if (getOption(field, array) === true) result = value
            else switch (field.fieldKind) {
                case "scalar": result = value; break
                case "enum": result = enumeration(field.enum, value); break
                case "message": result = message(field.message, value); break
                case "list": {
                    const item = field.listKind === "scalar" ? "item" : field.listKind === "enum" ? enumeration(field.enum, "item") : message(field.message, "item")
                    const size = getOption(field, fixed)
                    result = typeof size === "number" && size > 0 ? `tuple(${item} for item in fixed(${value}, ${size}))` : `[${item} for item in ${value}]`
                    break
                }
                case "map": {
                    const item = field.mapKind === "scalar" ? "item" : field.mapKind === "enum" ? enumeration(field.enum, "item") : message(field.message, "item")
                    result = `{key: ${item} for key, item in ${value}.items()}`
                    break
                }
            }
            return getOption(field, nullable) === true ? `(${value} if ${value} is None else ${result})` : result
        }
        const fields = (members: readonly DescField[], indent: string): string[] => members.flatMap(field => {
            const key = JSON.stringify(field.jsonName)
            const name = JSON.stringify(KEYWORDS.has(field.jsonName) ? `${field.jsonName}_` : field.jsonName)
            const absent = field.proto.proto3Optional || getOption(field, optional) === true
            return [
                `${indent}if ${key} in value:`,
                `${indent}    values[${name}] = ${convert(field, `value[${key}]`)}`,
                ...(!absent ? [`${indent}else:`, `${indent}    raise KeyError(${JSON.stringify(`missing ${field.jsonName}`)})`] : []),
            ]
        })
        const decode = (message: DescMessage): string[] => {
            const name = decoders.get(message)!
            const module = model(message.file)
            const tag = getOption(message, union)
            const lines = [`def ${name}(value):`, "    if not isinstance(value, dict):", `        raise TypeError(${JSON.stringify(`${message.name} must be an object`)})`]
            if (typeof tag === "string" && tag) {
                for (const field of message.fields) {
                    if (field.fieldKind !== "message") throw err("COGNET_SCHEMA_INVALID", { detail: `${message.file.name}.${message.name}: Python union member is not a message` })
                    const variant = `${local(message)}${field.jsonName[0]!.toUpperCase()}${field.jsonName.slice(1)}`
                    lines.push(`    if value.get(${JSON.stringify(tag)}) == ${JSON.stringify(field.jsonName)}:`, "        values = {}", ...fields(field.message.fields, "        "), `        return ${module}.${variant}(**values)`)
                }
                lines.push(`    raise ValueError(${JSON.stringify(`${message.name} has an unknown ${tag}`)})`, "")
            } else {
                lines.push("    values = {}", ...fields(message.fields, "    "), `    return ${module}.${local(message)}(**values)`, "")
            }
            return lines
        }
        const world = [
            "# Generated by axon prepare. Runtime access is enforced by cognet.Run.",
            "from cognet import Run",
            ...files.map((file, at) => `import cognet_generated.schema.${file.name.replace(/\.proto$/, "").split("/").map(rust.segment).join(".")} as model${at}`),
            "",
            "def fixed(value, size):",
            "    if not isinstance(value, (list, tuple)) or len(value) != size:",
            "        raise ValueError(f'fixed component tuple needs {size} values')",
            "    return value",
            "",
            ...messages.flatMap(decode),
            "HYDRATE = {",
            ...accessors.map(one => `    ${JSON.stringify(one.name)}: lambda value: ${convert(one.field, "value")},`),
            "}",
            "",
        ].join("\n")
        const stub = [
            "# Generated by axon prepare. Component names and values from types/.",
            "from typing import Generic, TypeVar, Any",
            "from cognet import Run as _Run",
            ...modules.map(module => `import ${module} as ${aliases.get(module)}`),
            "T = TypeVar('T')",
            "class ComponentView(Generic[T]):",
            "    def get(self, entity: str) -> T | None: ...",
            "    def first(self) -> tuple[str, T] | None: ...",
            "    def all(self) -> list[tuple[str, T]]: ...",
            "class Writer:",
            ...unique.map(one => `    def ${one.name.split("/").at(-1)}(self, value: ${hint(one)}) -> Writer: ...`),
            "    def remove(self, name: str) -> Writer: ...",
            "    def commit(self) -> None: ...",
            "class Ecs:",
            ...unique.map(one => `    ${one.name.split("/").at(-1)}: ComponentView[${hint(one)}]`),
            "    def has(self, entity: str) -> bool: ...",
            "    def write(self, entity: str) -> Writer: ...",
            "class Run(_Run):",
            "    ecs: Ecs",
            "",
        ].join("\n")
        generated.push(["cognet_generated/world.py", world], ["cognet_generated/world.pyi", stub])
        return generated
    },
}

function local(desc: DescMessage | DescEnum): string {
    return desc.parent ? `${local(desc.parent)}${desc.name}` : desc.name
}
