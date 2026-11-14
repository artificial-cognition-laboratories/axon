import { readFileSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"
import ts from "typescript"
import { err } from "@arcforge/err"
import type { Source } from "./compile"

/** A deliberately small, lossless TypeScript schema dialect. Unsupported types fail at prepare. */
export function Authored(opts: { root: string; files: readonly { absPath: string; relPath: string }[] }) {
    return {
        sources(): Source[] {
            const files = new Map<string, { named: string; package: string; ast: ts.SourceFile }>()
            for (const file of opts.files) {
                const named = file.relPath.slice("types/".length).replace(/(?:\.components)?\.ts$/, ".proto")
                const source = readFileSync(file.absPath, "utf8")
                const diagnostic = ts.transpileModule(source, { fileName: file.absPath, reportDiagnostics: true }).diagnostics?.find(one => one.category === ts.DiagnosticCategory.Error)
                if (diagnostic) fail(file.absPath, ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))
                const ast = ts.createSourceFile(file.absPath, source, ts.ScriptTarget.Latest, true)
                const pkg = ast.text.match(/@package\s+([^\s*]+)/)?.[1]
                if (!pkg || !/^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/.test(pkg)) fail(file.absPath, "a types file needs /** @package name.path */")
                files.set(resolve(file.absPath), { named: named, package: pkg, ast: ast })
            }
            return [...files].map(([absPath, file]) => ({ absPath: absPath, named: file.named, content: emit(opts.root, files, absPath, file) }))
        },
    }
}

function emit(root: string, files: Map<string, { named: string; package: string; ast: ts.SourceFile }>, path: string, file: { named: string; package: string; ast: ts.SourceFile }): string {
    const imports = new Map<string, { name: string; package: string; file: string }>()
    const dependencies = new Set<string>()
    for (const node of file.ast.statements) {
        if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) continue
        if (node.moduleSpecifier.text === "@arcforge/cognet/schema") continue
        const target = resolve(dirname(path), node.moduleSpecifier.text + ".ts")
        const imported = files.get(target)
        if (!imported) fail(path, `schema import ${node.moduleSpecifier.text} does not resolve to a types/ file`)
        dependencies.add(imported.named)
        for (const element of node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings) ? node.importClause.namedBindings.elements : []) {
            imports.set(element.name.text, { name: element.propertyName?.text ?? element.name.text, package: imported.package, file: imported.named })
        }
    }
    const declarations = new Map<string, ts.TypeNode>()
    const declared = new Map<string, ts.Statement>()
    for (const node of file.ast.statements) {
        if (ts.isImportDeclaration(node)) {
            if (node.importClause?.name || (node.importClause?.namedBindings && ts.isNamespaceImport(node.importClause.namedBindings))) fail(path, "schema imports must name their types explicitly")
            continue
        }
        if (ts.isTypeAliasDeclaration(node)) { declarations.set(node.name.text, node.type); declared.set(node.name.text, node); continue }
        if (ts.isInterfaceDeclaration(node)) { declarations.set(node.name.text, ts.factory.createTypeLiteralNode(node.members)); declared.set(node.name.text, node); continue }
        fail(path, `types/ may contain only imports, interfaces and type aliases; found ${ts.SyntaxKind[node.kind]}`)
    }
    const messages = new Map<string, string[]>()
    const enums = new Map<string, string[]>()
    const generated = new Set<string>()

    function nestedName(name: string, ast: ts.SourceFile): string {
        const declaration = ast.statements.find(statement => (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) && statement.name.text === name)
        const parent = declaration ? tag(declaration, ast, "nested") : undefined
        return parent ? `${nestedName(parent, ast)}.${name.slice(parent.length)}` : name
    }

    function typename(node: ts.TypeNode, owner: string): { type: string; suffix: string; options: string[] } {
        if (ts.isParenthesizedTypeNode(node)) return typename(node.type, owner)
        if (ts.isUnionTypeNode(node)) {
            const nonNull = node.types.filter(part => part.kind !== ts.SyntaxKind.NullKeyword && !(ts.isLiteralTypeNode(part) && part.literal.kind === ts.SyntaxKind.NullKeyword))
            if (nonNull.length === 1 && nonNull.length !== node.types.length) {
                const inner = typename(nonNull[0]!, owner)
                return { ...inner, options: [...inner.options, "(cognet.nullable) = true"] }
            }
            if (node.types.every(part => ts.isLiteralTypeNode(part) && ts.isStringLiteral(part.literal))) {
                enumeration(owner, node.types.map(part => (part as ts.LiteralTypeNode).literal as ts.StringLiteral))
                return { type: owner, suffix: "", options: [] }
            }
        }
        if (ts.isTypeLiteralNode(node)) {
            message(owner, node.members)
            return { type: owner, suffix: "", options: [] }
        }
        if (ts.isTupleTypeNode(node)) {
            if (!node.elements.length) fail(path, `${owner}: empty tuple is not a schema value`)
            const first = typename(node.elements[0]!, owner)
            if (node.elements.some(part => part.getText(file.ast) !== node.elements[0]!.getText(file.ast))) fail(path, `${owner}: tuples must have one element type`)
            return { type: first.type, suffix: "repeated", options: [...first.options, `(cognet.fixed) = ${node.elements.length}`] }
        }
        if (ts.isArrayTypeNode(node)) {
            const inner = typename(node.elementType, owner)
            if (inner.suffix) fail(path, `${owner}: nested arrays are not supported`)
            return { ...inner, suffix: "repeated" }
        }
        if (ts.isTypeReferenceNode(node)) {
            const name = node.typeName.getText(file.ast)
            const scalar: Record<string, string> = { u32: "uint32", i32: "int32", f32: "float", f64: "double", Float32Array: "float", Float64Array: "double", Int32Array: "int32", Uint32Array: "uint32", Uint8Array: "bytes" }
            if (name in scalar) return { type: scalar[name]!, suffix: name.endsWith("Array") && name !== "Uint8Array" ? "repeated" : "", options: name.endsWith("Array") && name !== "Uint8Array" ? ["(cognet.array) = true"] : [] }
            if ((name === "Record" || name === "Partial") && node.typeArguments) {
                const record = name === "Partial" ? node.typeArguments[0] : node
                if (!record || !ts.isTypeReferenceNode(record) || record.typeName.getText(file.ast) !== "Record" || record.typeArguments?.length !== 2) fail(path, `${owner}: expected Record<Key, Value>`)
                const key = record.typeArguments[0]!
                const value = typename(record.typeArguments[1]!, owner)
                if (value.suffix) fail(path, `${owner}: map values cannot be lists`)
                const keyed = key.kind === ts.SyntaxKind.StringKeyword || key.kind === ts.SyntaxKind.NumberKeyword ? [] : [`(cognet.keys) = ${JSON.stringify(qualified(key).replace(/^\./, ""))}`]
                return { type: `map<${key.kind === ts.SyntaxKind.NumberKeyword ? "int32" : "string"}, ${value.type}>`, suffix: "", options: keyed }
            }
            const local = declarations.get(name)
            if (local && ts.isTypeReferenceNode(local) && ["number", "string", "boolean"].includes(local.typeName.getText(file.ast))) return typename(local, owner)
            return { type: qualified(node), suffix: "", options: [] }
        }
        if (node.kind === ts.SyntaxKind.NumberKeyword) return { type: "double", suffix: "", options: [] }
        if (node.kind === ts.SyntaxKind.StringKeyword) return { type: "string", suffix: "", options: [] }
        if (node.kind === ts.SyntaxKind.BooleanKeyword) return { type: "bool", suffix: "", options: [] }
        fail(path, `${owner}: unsupported TypeScript type ${node.getText(file.ast)}`)
    }

    function qualified(node: ts.TypeNode): string {
        if (!ts.isTypeReferenceNode(node)) fail(path, `expected a named type, got ${node.getText(file.ast)}`)
        const name = node.typeName.getText(file.ast)
        const from = imports.get(name)
        if (from) {
            const imported = [...files.values()].find(file => file.named === from.file)
            return `.${from.package}.${imported ? nestedName(from.name, imported.ast) : from.name}`
        }
        if (declarations.has(name)) {
            return nestedName(name, file.ast)
        }
        fail(path, `unknown type ${name}`)
    }

    function enumeration(name: string, values: readonly ts.StringLiteral[]): void {
        if (generated.has(name)) fail(path, `${name}: duplicate generated type`)
        generated.add(name)
        const parent = declared.has(name) ? tag(declared.get(name)!, file.ast, "nested") : undefined
        const shortName = parent ? name.slice(parent.length) : name
        const prefix = shortName.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase()
        const lines = [...docs(declared.get(name), file.ast, ""), `enum ${name} {`, `  ${prefix}_UNSPECIFIED = 0;`]
        const used = new Set<string>()
        values.forEach((value, index) => {
            const key = value.text.replace(/([a-z])([A-Z])/g, "$1_$2").replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()
            if (!key || used.has(key)) fail(path, `${name}: enum values need distinct protobuf names`)
            used.add(key)
            const natural = key.toLowerCase().replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())
            const option = natural === value.text ? "" : ` [(cognet.text) = ${JSON.stringify(value.text)}]`
            lines.push(`  ${prefix}_${key} = ${index + 1}${option};`)
        })
        enums.set(name, [...lines, "}"])
    }

    function message(name: string, members: ts.NodeArray<ts.TypeElement>): void {
        if (generated.has(name)) fail(path, `${name}: duplicate generated type`)
        generated.add(name)
        const lines = [...docs(declared.get(name), file.ast, ""), `message ${name} {`]
        const declaration = declared.get(name)
        // A container is said by its tag, or by what every member is — the same rule for components and frames.
        const all = (wrapper: string) => members.length > 0 && members.every(member => ts.isPropertySignature(member) && member.type && ts.isTypeReferenceNode(member.type) && member.type.typeName.getText(file.ast) === wrapper)
        const componentContainer = declaration && (tag(declaration, file.ast, "components") !== undefined || all("Component"))
        const frameContainer = declaration && (tag(declaration, file.ast, "frames") !== undefined || all("Frame"))
        const container = declaration && (componentContainer || frameContainer)
        const kind = componentContainer ? "Components" : frameContainer ? "Frames" : null
        if (container && kind) lines.push(`  option (cognet.${kind.toLowerCase()}) = true;`)
        let next = 1
        for (const member of members) {
            if (!ts.isPropertySignature(member) || !member.type || !member.name) fail(path, `${name}: only typed properties can be schema fields`)
            const key = member.name.getText(file.ast).replace(/^['"]|['"]$/g, "")
            const number = tag(member, file.ast, "field")
            if (number && !/^[1-9]\d*$/.test(number)) fail(path, `${name}.${key}: invalid protobuf field number ${number}`)
            const fieldNumber = number ? Number(number) : next
            next = fieldNumber + 1
            const wrapper = container && ts.isTypeReferenceNode(member.type) ? member.type : undefined
            const wrapped = wrapper?.typeName.getText(file.ast)
            if (container && wrapped !== (kind === "Components" ? "Component" : "Frame")) fail(path, `${name}.${key}: expected ${kind === "Components" ? "Component<T, Options>" : "Frame<Options>"}`)
            const value = kind === "Frames" ? { type: "cognet.Frame", suffix: "", options: [] } : typename(container ? wrapper!.typeArguments?.[0] ?? member.type : member.type, `${name}${key[0]!.toUpperCase()}${key.slice(1)}`)
            const fieldName = key.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase()
            const extra = [...value.options]
            if (member.questionToken && value.suffix) extra.push("(cognet.optional) = true")
            if (container) {
                const options = kind === "Frames" ? wrapper!.typeArguments?.[0] : wrapper!.typeArguments?.[1]
                if (!options) fail(path, `${name}.${key}: supply options`)
                extra.push(`(cognet.${kind === "Frames" ? "frame" : "component"}) = ${option(options, kind === "Frames" ? "frame" : "component")}`)
            }
            const required = member.questionToken && !value.suffix ? "optional " : ""
            const repeated = value.suffix ? `${value.suffix} ` : ""
            const options = extra.length ? ` [${extra.join(", ")}]` : ""
            lines.push(...docs(member, file.ast, "  "), `  ${required}${repeated}${value.type} ${fieldName} = ${fieldNumber}${options};`)
        }
        messages.set(name, [...lines, "}"])
    }

    function union(name: string, node: ts.UnionTypeNode, key: string): void {
        const lines = [`message ${name} {`, `  option (cognet.union) = ${JSON.stringify(key)};`, `  oneof ${name.toLowerCase()} {`]
        node.types.forEach((part, index) => {
            const variant = ts.isParenthesizedTypeNode(part) ? part.type : part
            if (!ts.isIntersectionTypeNode(variant) || variant.types.length !== 2 || !ts.isTypeLiteralNode(variant.types[0]!) || !ts.isTypeReferenceNode(variant.types[1]!)) fail(path, `${name}: union members must be { ${key}: "name" } & Message`)
            const tag = variant.types[0]!.members[0]
            if (!tag || !ts.isPropertySignature(tag) || tag.name?.getText(file.ast) !== key || !tag.type || !ts.isLiteralTypeNode(tag.type) || !ts.isStringLiteral(tag.type.literal)) fail(path, `${name}: each member needs a ${key} string literal`)
            const field = tag.type.literal.text.replace(/([a-z])([A-Z])/g, "$1_$2").replace(/-/g, "_").toLowerCase()
            lines.push(`    ${qualified(variant.types[1]!)} ${field} = ${index + 1};`)
        })
        messages.set(name, [...lines, "  }", "}"])
    }

    function option(node: ts.TypeNode, context: string): string {
        if (!ts.isTypeLiteralNode(node)) fail(path, `${context}: options must be a type literal`)
        const values = node.members.map(member => {
            if (!ts.isPropertySignature(member) || !member.type || !member.name) fail(path, `${context}: invalid option`)
            const key = member.name.getText(file.ast)
            const value = member.type
            if (ts.isTypeLiteralNode(value)) return `${key}: ${option(value, key)}`
            if (ts.isTupleTypeNode(value)) return `${key}: [${value.elements.map(element => element.getText(file.ast)).join(", ")}]`
            if (ts.isLiteralTypeNode(value)) {
                if (value.literal.kind === ts.SyntaxKind.TrueKeyword) return `${key}: true`
                if (value.literal.kind === ts.SyntaxKind.FalseKeyword) return `${key}: false`
                if (ts.isNumericLiteral(value.literal)) return `${key}: ${value.literal.text}`
                if (ts.isPrefixUnaryExpression(value.literal)) return `${key}: ${value.literal.getText(file.ast)}`
                if (ts.isStringLiteral(value.literal)) {
                    const text = value.literal.text
                    const enums: Record<string, string> = { domain: "DOMAIN", shape: "SHAPE", archetype: "ARCHETYPE", instrument: "INSTRUMENT", kind: "KIND" }
                    const code = enums[key]
                    return `${key.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase()}: ${code ? `${code}_${text.replace(/-/g, "_").toUpperCase()}` : JSON.stringify(text)}`
                }
            }
            fail(path, `${context}.${key}: options need literal values`)
        })
        return `{ ${values.join(", ")} }`
    }

    for (const [name, node] of declarations) {
        if (["u32", "i32", "f32", "f64"].includes(name)) continue
        const declaration = file.ast.statements.find(statement => (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) && statement.name.text === name)
        const unionKey = declaration ? tag(declaration, file.ast, "union") : undefined
        if (unionKey && ts.isUnionTypeNode(node)) union(name, node, unionKey)
        else if (ts.isTypeLiteralNode(node)) message(name, node.members)
        else if (ts.isUnionTypeNode(node) && node.types.every(part => ts.isLiteralTypeNode(part) && ts.isStringLiteral(part.literal))) enumeration(name, node.types.map(part => (part as ts.LiteralTypeNode).literal as ts.StringLiteral))
        else fail(path, `${name}: top-level aliases must be object shapes or string literal unions`)
    }
    const importLines = [...dependencies].sort().map(name => `import ${JSON.stringify(name)};`)
    const allBlocks = new Map([...enums, ...messages])
    const parentOf = (name: string) => declared.has(name) ? tag(declared.get(name)!, file.ast, "nested") : undefined
    for (const name of allBlocks.keys()) {
        const parent = parentOf(name)
        if (parent && !allBlocks.has(parent)) fail(path, `${name}: nested parent ${parent} is not declared`)
    }
    const render = (name: string): string[] => {
        const block = allBlocks.get(name)
        if (!block) fail(path, `${name}: nested type has no declaration`)
        const parent = parentOf(name)
        const own = parent ? block.map(line => line.replace(new RegExp(`^(message|enum) ${name} \\{`), `$1 ${name.slice(parent.length)} {`)) : block
        const children = [...allBlocks.keys()].filter(child => parentOf(child) === name)
        const inside = children.flatMap(child => render(child).map(line => line ? `  ${line}` : ""))
        return [...own.slice(0, -1), ...inside, own.at(-1)!, ""]
    }
    const declarationsOut = [...allBlocks.keys()].filter(name => parentOf(name) === undefined).flatMap(render)
    const runtime = declarationsOut.some(line => line.includes("(cognet.")) ? ['import "cognet/cognet.proto";'] : []
    const head = file.ast.text.slice(0, file.ast.statements[0]?.getStart(file.ast) ?? 0)
    const fileDocs = [...head.matchAll(/\/\*\*([\s\S]*?)\*\//g)].filter(match => !match[1]?.includes("@package"))
        .flatMap(match => match[1]!.split("\n").map(line => line.replace(/^\s*\*?\s?/, "").trim()))
    return [...fileDocs.map(line => line ? `// ${line}` : "//"), `// Generated by axon prepare from ${relative(root, path)}.`, 'syntax = "proto3";', `package ${file.package};`, "", ...runtime, ...importLines, "", ...declarationsOut].join("\n")
}
function tag(node: ts.Node, source: ts.SourceFile, name: string): string | undefined {
    const match = node.getFullText(source).slice(0, node.getStart(source) - node.getFullStart()).match(new RegExp(`@${name}(?:\\s+([^\\s*]+))?`))
    return match ? match[1] ?? "" : undefined
}

function docs(node: ts.Node | undefined, source: ts.SourceFile, indent: string): string[] {
    if (!node) return []
    const before = node.getFullText(source).slice(0, node.getStart(source) - node.getFullStart())
    const comments = [...before.matchAll(/\/\*\*([\s\S]*?)\*\//g)]
    return comments.flatMap(comment => comment[1]!.split("\n"))
        .map(line => line.replace(/^\s*\*?\s?/, "").replace(/@(field|components|frames|union|nested)\s*[^\s*]*/, "").trim())
        .filter(line => line.length > 0)
        .map(line => `${indent}// ${line}`)
}

function fail(file: string, detail: string): never {
    throw err("COGNET_SCHEMA_INVALID", { detail: `${file}: ${detail}` })
}
