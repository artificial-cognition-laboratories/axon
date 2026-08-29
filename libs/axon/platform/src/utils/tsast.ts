import ts from "typescript"

/**
 * Shared TypeScript AST introspection tools — the one place source files
 * are parsed for declarations. Blueprint scan leaves (tools, scripts,
 * module metadata) build their domain logic on these primitives.
 */
export const tsast = {
    parse(filePath: string, source: string): ts.SourceFile {
        return ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    },

    hasExportModifier(node: ts.Node): boolean {
        if (ts.canHaveModifiers(node)) {
            const mods = ts.getModifiers(node)
            return mods?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) ?? false
        }
        return false
    },

    /** Render a parameter list back to source text: "a: string, b?: number". */
    params(params: ts.NodeArray<ts.ParameterDeclaration>, src: ts.SourceFile): string {
        return params
            .map(p => {
                const name = p.name.getText(src)
                const type = p.type ? `: ${p.type.getText(src)}` : ""
                const opt = p.questionToken ? "?" : ""
                const rest = p.dotDotDotToken ? "..." : ""
                return `${rest}${name}${opt}${type}`
            })
            .join(", ")
    },

    /** The JSDoc block immediately preceding a node, cleaned of comment syntax. */
    jsdoc(node: ts.Node, src: ts.SourceFile): string | undefined {
        const fullText = src.getFullText()
        const trivia = fullText.slice(node.getFullStart(), node.getStart(src))
        const match = trivia.match(/\/\*\*([\s\S]*?)\*\/\s*$/)
        if (!match) return undefined
        const lines = match[1]!.split("\n").map(l => l.replace(/^\s*\*\s?/, "").trimEnd())
        while (lines.length > 0 && lines[0]!.trim() === "") lines.shift()
        while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop()
        return lines.length > 0 ? lines.join("\n") : undefined
    },

    /** The first line of a file-leading JSDoc block. */
    leadingDescription(source: string): string | undefined {
        const match = source.match(/^\s*\/\*\*([\s\S]*?)\*\//)
        if (!match) return undefined
        const lines = match[1]!.split("\n").map(l => l.replace(/^\s*\*\s?/, "").trim()).filter(Boolean)
        return lines[0]
    },

    // ── Object-literal property readers ──────────────────────────────────────

    prop(obj: ts.ObjectLiteralExpression, key: string): ts.Expression | null {
        for (const p of obj.properties) {
            if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === key) {
                return p.initializer
            }
        }
        return null
    },

    stringProp(obj: ts.ObjectLiteralExpression, key: string): string | null {
        const init = tsast.prop(obj, key)
        return init && ts.isStringLiteral(init) ? init.text : null
    },

    boolProp(obj: ts.ObjectLiteralExpression, key: string): boolean | null {
        const init = tsast.prop(obj, key)
        if (!init) return null
        if (init.kind === ts.SyntaxKind.TrueKeyword) return true
        if (init.kind === ts.SyntaxKind.FalseKeyword) return false
        return null
    },

    objectProp(obj: ts.ObjectLiteralExpression, key: string): ts.ObjectLiteralExpression | null {
        const init = tsast.prop(obj, key)
        return init && ts.isObjectLiteralExpression(init) ? init : null
    },

    /** Extract a primitive literal value (string/number/boolean), or undefined. */
    literal(node: ts.Expression): string | number | boolean | undefined {
        if (ts.isStringLiteral(node)) return node.text
        if (ts.isNumericLiteral(node)) return Number(node.text)
        if (node.kind === ts.SyntaxKind.TrueKeyword) return true
        if (node.kind === ts.SyntaxKind.FalseKeyword) return false
        return undefined
    },

    /** Visit every call expression `name(...)` in a source file. */
    visitCalls(src: ts.SourceFile, name: string, visit: (call: ts.CallExpression) => void): void {
        function walk(node: ts.Node) {
            if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) {
                visit(node)
            }
            ts.forEachChild(node, walk)
        }
        ts.forEachChild(src, walk)
    },
}
