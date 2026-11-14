import { readFileSync } from "node:fs"
import ts from "typescript"
import { err } from "@arcforge/err"
import type { EngineRequirements } from "@arcforge/types"
import { Literal } from "./literal"
import { engines } from "./shape"

/**
 * ProviderFile — what a provider the agent wrote declares, read without
 * running it: the interface it implements, and the engines it needs from the
 * machine. Static for the reason cognet.config.ts is, and one more: a
 * confined agent's supervisor resolves those engines, and must never run the
 * agent's code outside its box to learn what they are.
 */
export function ProviderFile(opts: { filePath: string }) {
    return {
        read(): { implements: string; engines: EngineRequirements } {
            const source = ts.createSourceFile(opts.filePath, readFileSync(opts.filePath, "utf8"), ts.ScriptTarget.Latest, true)
            const declared = definition(source, opts.filePath)
            const literal = Literal({ file: opts.filePath, source: source })
            const field = (name: string) => declared.properties.find(property => ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === name) as ts.PropertyAssignment | undefined
            const implemented = field("implements")
            const named = implemented ? literal.read(implemented.initializer, "implements") : undefined
            if (typeof named !== "string") throw invalid(opts.filePath, "defineProvider({ implements: \"<interface>@<major>\", … }) — written out")
            const needs = field("engines")
            return { implements: named, engines: needs ? engines(literal.read(needs.initializer, "engines"), opts.filePath) : {} }
        },
    }
}

/** The object handed to `defineProvider` in the default export. */
function definition(source: ts.SourceFile, path: string): ts.ObjectLiteralExpression {
    const exported = source.statements.find(ts.isExportAssignment)
    let call = exported?.expression
    while (call && (ts.isParenthesizedExpression(call) || ts.isAsExpression(call) || ts.isSatisfiesExpression(call))) call = call.expression
    const argument = call && ts.isCallExpression(call) && ts.isIdentifier(call.expression) && call.expression.text === "defineProvider" ? call.arguments[0] : undefined
    if (!argument || !ts.isObjectLiteralExpression(argument)) throw invalid(path, "the default export must be defineProvider({ … })")
    return argument
}

function invalid(path: string, must: string) {
    return err("SERVICE_INVALID", { detail: `${path}: ${must}`, context: { provider: path } })
}
