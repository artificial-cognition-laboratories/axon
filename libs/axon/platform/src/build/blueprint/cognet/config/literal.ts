import ts from "typescript"
import { err } from "@arcforge/err"

/** A value written out in source: what a static config may hold. */
export type Literal = string | number | boolean | null | Literal[] | { [key: string]: Literal }

/**
 * Literal — the value a TypeScript expression WRITES OUT, read without running
 * it. Objects, arrays, strings, numbers (`100_000`, `-1`), booleans, `null`,
 * and a top-level `const` holding one of those; `as const`, `satisfies` and
 * parentheses are seen through. Anything else — a call, a spread, an import,
 * a template with a substitution — throws COGNET_CONFIG_NOT_STATIC naming the
 * field and the line, because a value that must be computed cannot be known
 * before the code that computes it exists.
 */
export function Literal(opts: { file: string; source: ts.SourceFile }) {
    const consts = new Map<string, ts.Expression>()
    for (const statement of opts.source.statements) {
        if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue
        for (const declaration of statement.declarationList.declarations) {
            if (ts.isIdentifier(declaration.name) && declaration.initializer) consts.set(declaration.name.text, declaration.initializer)
        }
    }
    const resolving = new Set<string>()

    function read(node: ts.Expression, path: string): Literal {
        if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) return read(node.expression, path)
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
        if (ts.isNumericLiteral(node)) return Number(node.text)
        if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand)) return -Number(node.operand.text)
        if (node.kind === ts.SyntaxKind.TrueKeyword) return true
        if (node.kind === ts.SyntaxKind.FalseKeyword) return false
        if (node.kind === ts.SyntaxKind.NullKeyword) return null
        if (ts.isArrayLiteralExpression(node)) return node.elements.map((element, index) => read(element, `${path}[${index}]`))
        if (ts.isObjectLiteralExpression(node)) return object(node, path)
        if (ts.isIdentifier(node)) return named(node, path)
        return fail(node, path, `\`${node.getText(opts.source)}\``)
    }

    function object(node: ts.ObjectLiteralExpression, path: string): { [key: string]: Literal } {
        const value: { [key: string]: Literal } = {}
        for (const property of node.properties) {
            if (ts.isShorthandPropertyAssignment(property)) {
                value[property.name.text] = named(property.name, join(path, property.name.text))
                continue
            }
            if (!ts.isPropertyAssignment(property)) return fail(property, path, `\`${property.getText(opts.source)}\``)
            const key = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) || ts.isNumericLiteral(property.name)
                ? property.name.text
                : fail(property.name, path, `the computed key \`${property.name.getText(opts.source)}\``)
            value[key] = read(property.initializer, join(path, key))
        }
        return value
    }

    function named(node: ts.Identifier, path: string): Literal {
        if (node.text === "undefined") return fail(node, path, "`undefined` — leave the field out instead")
        const initializer = consts.get(node.text)
        if (!initializer) return fail(node, path, `\`${node.text}\`, which is not a top-level const of this file`)
        if (resolving.has(node.text)) return fail(node, path, `\`${node.text}\`, which refers to itself`)
        resolving.add(node.text)
        const value = read(initializer, path)
        resolving.delete(node.text)
        return value
    }

    function fail(node: ts.Node, path: string, what: string): never {
        const line = opts.source.getLineAndCharacterOfPosition(node.getStart(opts.source)).line + 1
        throw err("COGNET_CONFIG_NOT_STATIC", {
            detail: `${opts.file}:${line}: \`${path || "the config"}\` is ${what} — write the value out`,
            context: { file: opts.file, line: line, field: path },
        })
    }

    return {
        /** The value `node` writes out, named `path` in errors. */
        read: read,
    }
}

function join(path: string, key: string): string {
    return path ? `${path}.${key}` : key
}
