import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import ts from "typescript"
import { err } from "@arcforge/err"
import type { CognetConfig } from "@arcforge/types"
import { Literal } from "./literal"
import { shape } from "./shape"

/**
 * CognetConfigFile — a cognet's `cognet.config.ts`, read without running it.
 *
 * Read statically because it is needed before anything can run it: prepare
 * checks the ABI, fetches what it suggests and grants what it uses before the
 * cognet is compiled or its dependencies installed. So the file is parsed —
 * `export default defineCognet({ … })` — and every value must be written out.
 * One reader for every field: a field is read the same way everywhere, and a
 * value that can't be known statically fails loudly rather than reading as
 * absent.
 */
export function CognetConfigFile(opts: { sourceDir: string }) {
    const path = join(opts.sourceDir, "cognet.config.ts")

    return {
        path: path,
        /** Whether the cognet has one. A cognet without one wakes on the defaults. */
        exists(): boolean {
            return existsSync(path)
        },
        /** The config, validated; null when the cognet has none. Throws COGNET_CONFIG_NOT_STATIC or COGNET_CONFIG_INVALID. */
        read(): CognetConfig | null {
            if (!existsSync(path)) return null
            const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true)
            return shape(Literal({ file: path, source: source }).read(declared(source, path), ""), path)
        },
    }
}

export type CognetConfigFileT = ReturnType<typeof CognetConfigFile>

/** The object handed to `defineCognet` in the default export. */
function declared(source: ts.SourceFile, path: string): ts.Expression {
    const exported = source.statements.find(ts.isExportAssignment)
    const call = exported && unwrap(exported.expression)
    if (!call || !ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || call.expression.text !== "defineCognet" || call.arguments.length !== 1) {
        throw err("COGNET_CONFIG_INVALID", { detail: `${path}: the default export must be \`defineCognet({ … })\``, context: { file: path, field: "" } })
    }
    return call.arguments[0]!
}

function unwrap(node: ts.Expression): ts.Expression {
    return ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) ? unwrap(node.expression) : node
}
