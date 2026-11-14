import { dirname, resolve } from "node:path"
import ts from "typescript"
import { fail, type Answer, type Contract, type Field, type Import, type Method, type Shape } from "./model"

/** How an interface file differs from a component file: it holds a contract, and handles, and imports the standard interfaces by package. */
type InterfaceOpts = { contract: true; resolve(specifier: string): string | null }

/**
 * Read native TypeScript declarations; exports select components, not wrappers.
 * With `contract`, the file is an interface: its one exported interface with
 * methods is the contract, and `Handle<"Name">` aliases are handles.
 */
export function typescript(path: string, text: string, opts?: InterfaceOpts): { shapes: Shape[]; imports: Record<string, Import>; contracts: Contract[] } {
    const diagnostic = ts.transpileModule(text, { fileName: path, reportDiagnostics: true }).diagnostics?.find(one => one.category === ts.DiagnosticCategory.Error)
    if (diagnostic) fail(path, ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))
    const ast = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const shapes: Shape[] = []
    const contracts: Contract[] = []
    const imports: Record<string, Import> = {}
    for (const node of ast.statements) {
        if (ts.isImportDeclaration(node)) {
            if (!node.importClause?.isTypeOnly) fail(path, "component sources may only import types")
            if (!ts.isStringLiteral(node.moduleSpecifier)) fail(path, "component type imports need a string path")
            const packaged = node.moduleSpecifier.text.startsWith(".") ? null : opts?.resolve(node.moduleSpecifier.text) ?? null
            if (node.moduleSpecifier.text.startsWith(".") || packaged) {
                const target = packaged ?? resolve(dirname(path), withTs(node.moduleSpecifier.text))
                const bindings = node.importClause.namedBindings
                if (!bindings || !ts.isNamedImports(bindings)) fail(path, "component type imports must name their types")
                for (const binding of bindings.elements) imports[binding.name.text] = { path: target, name: binding.propertyName?.text ?? binding.name.text }
            }
            continue
        }
        if (!ts.isInterfaceDeclaration(node) && !ts.isTypeAliasDeclaration(node)) fail(path, `unsupported statement ${ts.SyntaxKind[node.kind]}; use interfaces and type aliases`)
        if (opts && ts.isInterfaceDeclaration(node) && node.members.some(ts.isMethodSignature)) {
            contracts.push(contract(node))
            continue
        }
        if (opts && ts.isTypeAliasDeclaration(node) && handle(node.type)) {
            if (handle(node.type) !== node.name.text) fail(path, `${node.name.text}: a handle is named as its type — Handle<"${node.name.text}">`)
            shapes.push({ name: node.name.text, fields: [], component: false, handle: true, doc: docOf(node) })
            continue
        }
        const component = node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false
        if (node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword)) fail(path, "components need named exports")
        if (ts.isInterfaceDeclaration(node) && node.heritageClauses?.length) fail(path, `${node.name.text}: interface extension is not a wire shape`)
        const doc = docOf(node)
        const literal = ts.isInterfaceDeclaration(node) ? node.members : ts.isTypeLiteralNode(node.type) ? node.type.members : null
        const alias = literal ? undefined : ts.isTypeAliasDeclaration(node) ? type(node.type) : undefined
        if (!literal && !alias) fail(path, `${node.name.text}: expected an object type or supported alias`)
        const fields: Field[] = []
        for (const member of literal ?? []) {
            if (!ts.isPropertySignature(member) || !member.type || !member.name || !(ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))) fail(path, `${node.name.text}: only named, typed fields are supported`)
            const nullable = nullableType(member.type)
            const value = type(nullable ?? member.type)
            fields.push({ name: member.name.text, type: value, optional: !!member.questionToken, nullable: !!nullable })
        }
        shapes.push({ name: node.name.text, fields: fields, component: component, alias: alias, doc: doc })
    }
    return { shapes: shapes, imports: imports, contracts: contracts }

    function contract(node: ts.InterfaceDeclaration): Contract {
        const methods = node.members.map((member): Method => {
            if (!ts.isMethodSignature(member) || !ts.isIdentifier(member.name) || !member.type) fail(path, `${node.name.text}: an interface holds only methods, each with a return type`)
            const name = member.name.text
            const params = member.parameters.map(parameter => {
                if (!ts.isIdentifier(parameter.name) || !parameter.type) fail(path, `${node.name.text}.${name}: every argument needs a name and a type`)
                return { name: parameter.name.text, type: type(parameter.type), optional: !!parameter.questionToken }
            })
            const returned = member.type
            const wrapper = ts.isTypeReferenceNode(returned) ? returned.typeName.getText(ast) : null
            const args = ts.isTypeReferenceNode(returned) ? returned.typeArguments ?? [] : []
            const doc = docOf(member)
            if (name === "describe") {
                if (params.length) fail(path, `${node.name.text}.describe: takes no arguments`)
                if (wrapper) fail(path, `${node.name.text}.describe: answers plainly, at once — not a Promise; write what it reports`)
                return { name: name, doc: doc, params: [], kind: "describe", answer: answer(returned, `${node.name.text}.describe`) }
            }
            if (wrapper === "Promise" && args.length === 1) return { name: name, doc: doc, params: params, kind: "call", answer: answer(args[0]!, `${node.name.text}.${name}`) }
            if (wrapper === "AsyncIterable" && args.length === 1) return { name: name, doc: doc, params: params, kind: "stream", answer: required(answer(args[0]!, `${node.name.text}.${name}`), name) }
            if (wrapper === "Session" && args.length === 2) {
                if (params.length) fail(path, `${node.name.text}.${name}: a session opens with no arguments — what it needs is pushed`)
                return { name: name, doc: doc, params: [], kind: "session", push: named(args[0]!, `${node.name.text}.${name}`), answer: required(answer(args[1]!, `${node.name.text}.${name}`), name) }
            }
            fail(path, `${node.name.text}.${name}: must return Promise<T>, AsyncIterable<T> or Session<Push, Answer>`)
        })
        if (!methods.some(method => method.kind === "describe")) fail(path, `${node.name.text}: every interface declares describe(), even one reporting nothing — describe(): {}`)
        return { name: node.name.text, doc: docOf(node), methods: methods }
    }

    function answer(node: ts.TypeNode, owner: string): Answer {
        if (node.kind === ts.SyntaxKind.VoidKeyword) return null
        if (ts.isTypeLiteralNode(node)) {
            return { inline: node.members.map(member => {
                if (!ts.isPropertySignature(member) || !member.type || !member.name || !(ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))) fail(path, `${owner}: only named, typed fields are supported`)
                return { name: member.name.text, type: type(member.type), optional: !!member.questionToken }
            }) }
        }
        return { named: named(node, owner) }
    }

    function named(node: ts.TypeNode, owner: string): string {
        if (!ts.isTypeReferenceNode(node) || node.typeArguments?.length) fail(path, `${owner}: answers and pushes are named types or fields written inline, not ${node.getText(ast)}`)
        return node.typeName.getText(ast)
    }

    function required(value: Answer, name: string): Answer {
        if (value === null) fail(path, `${name}: a stream or session answers with something`)
        return value
    }

    function handle(node: ts.TypeNode): string | null {
        if (!ts.isTypeReferenceNode(node) || node.typeName.getText(ast) !== "Handle") return null
        const [name] = node.typeArguments ?? []
        if (!name || !ts.isLiteralTypeNode(name) || !ts.isStringLiteral(name.literal)) fail(path, `Handle<"Name"> takes its name as a string`)
        return name.literal.text
    }

    function docOf(node: ts.Node): string | undefined {
        // As written, tags and all: what a tag says is read by `said`, the same for every language.
        const doc = ts.getJSDocCommentsAndTags(node).filter(ts.isJSDoc).map(comment => comment.getText(ast).replace(/^\/\*\*|\*\/$/g, "").split("\n").map(line => line.replace(/^\s*\*?\s?/, "").trimEnd()).join("\n").trim()).join("\n")
        return doc || undefined
    }

    function type(node: ts.TypeNode): string {
        if (ts.isParenthesizedTypeNode(node)) return type(node.type)
        if (ts.isArrayTypeNode(node)) return `Vec<${type(node.elementType)}>`
        if (ts.isTupleTypeNode(node)) {
            if (node.elements.length === 0) fail(path, "empty tuples are not component values")
            const elements = node.elements.map(type)
            if (elements.some(element => element !== elements[0])) fail(path, "fixed tuples must use one element type")
            return `Fixed<${elements[0]},${elements.length}>`
        }
        if (ts.isTypeReferenceNode(node)) {
            const name = node.typeName.getText(ast)
            const args = node.typeArguments?.map(type) ?? []
            if (name === "Array" && args.length === 1) return `Vec<${args[0]}>`
            if (name === "Record" && args.length === 2) return `Record<${args.join(",")}>`
            if (name === "Partial" && args.length === 1 && args[0]!.startsWith("Record<")) return args[0]!
            if (args.length) fail(path, `unsupported type ${node.getText(ast)}`)
            return name
        }
        if (node.kind === ts.SyntaxKind.NumberKeyword) return "number"
        if (node.kind === ts.SyntaxKind.StringKeyword) return "string"
        if (node.kind === ts.SyntaxKind.BooleanKeyword) return "boolean"
        fail(path, `unsupported TypeScript field type ${node.getText(ast)}`)
    }

    function nullableType(node: ts.TypeNode): ts.TypeNode | null {
        if (!ts.isUnionTypeNode(node)) return null
        const values = node.types.filter(part => !(ts.isLiteralTypeNode(part) && part.literal.kind === ts.SyntaxKind.NullKeyword))
        return values.length === 1 && values.length < node.types.length ? values[0]! : null
    }
}

function withTs(specifier: string): string {
    return specifier.endsWith(".ts") ? specifier : `${specifier}.ts`
}
