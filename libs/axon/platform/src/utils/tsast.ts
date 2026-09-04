import type ts from "typescript"

/**
 * The TypeScript compiler, loaded on FIRST USE rather than at import.
 *
 * `typescript` costs ~223ms to load — roughly half of `@arcforge/platform`'s
 * entire import time, which every `axon` invocation paid before a single line
 * of any command ran. `axon dev` printing nothing for a second was mostly
 * this: the progress surface could not paint because its own module graph was
 * still loading a compiler it had no use for.
 *
 * Nothing here touches `ts` at module scope — every reference is inside a
 * function body — so deferring the load costs the first caller ~223ms and
 * every command that never parses a source file nothing at all.
 *
 * `require`, not `await import`: these are SYNCHRONOUS APIs
 * (`readSettingsSync` is named for it, and is called during Platform()'s own
 * settings read), so making them async would ripple through every caller for
 * no gain. Bun resolves this from the same graph either way.
 *
 * The type import above is erased at compile time and carries no runtime cost,
 * which is what keeps every `ts.SourceFile` annotation below unchanged.
 */
let _ts: typeof ts | undefined
function tsc(): typeof ts {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- see above
    return (_ts ??= require("typescript") as typeof ts)
}


/**
 * Shared TypeScript AST introspection tools — the one place source files
 * are parsed for declarations. Blueprint scan leaves (tools, scripts,
 * module metadata) build their domain logic on these primitives.
 */
export const tsast = {
    parse(filePath: string, source: string): ts.SourceFile {
        return tsc().createSourceFile(filePath, source, tsc().ScriptTarget.Latest, true, tsc().ScriptKind.TS)
    },

    hasExportModifier(node: ts.Node): boolean {
        if (tsc().canHaveModifiers(node)) {
            const mods = tsc().getModifiers(node)
            return mods?.some(m => m.kind === tsc().SyntaxKind.ExportKeyword) ?? false
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
            if (tsc().isPropertyAssignment(p) && (tsc().isIdentifier(p.name) || tsc().isStringLiteral(p.name)) && p.name.text === key) {
                return p.initializer
            }
        }
        return null
    },

    stringProp(obj: ts.ObjectLiteralExpression, key: string): string | null {
        const init = tsast.prop(obj, key)
        return init && tsc().isStringLiteral(init) ? init.text : null
    },

    boolProp(obj: ts.ObjectLiteralExpression, key: string): boolean | null {
        const init = tsast.prop(obj, key)
        if (!init) return null
        if (init.kind === tsc().SyntaxKind.TrueKeyword) return true
        if (init.kind === tsc().SyntaxKind.FalseKeyword) return false
        return null
    },

    objectProp(obj: ts.ObjectLiteralExpression, key: string): ts.ObjectLiteralExpression | null {
        const init = tsast.prop(obj, key)
        return init && tsc().isObjectLiteralExpression(init) ? init : null
    },

    /** Extract a primitive literal value (string/number/boolean), or undefined. */
    literal(node: ts.Expression): string | number | boolean | undefined {
        if (tsc().isStringLiteral(node)) return node.text
        if (tsc().isNumericLiteral(node)) return Number(node.text)
        if (node.kind === tsc().SyntaxKind.TrueKeyword) return true
        if (node.kind === tsc().SyntaxKind.FalseKeyword) return false
        return undefined
    },

    /** Visit every call expression `name(...)` in a source file. */
    visitCalls(src: ts.SourceFile, name: string, visit: (call: ts.CallExpression) => void): void {
        function walk(node: ts.Node) {
            if (tsc().isCallExpression(node) && tsc().isIdentifier(node.expression) && node.expression.text === name) {
                visit(node)
            }
            tsc().forEachChild(node, walk)
        }
        tsc().forEachChild(src, walk)
    },
}
