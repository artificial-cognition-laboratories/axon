import type TsNamespace from "typescript"
import type { ModuleOptionSchema } from "@arcforge/types"
import { fsx } from "../../../utils/fs"

/**
 * `typescript` is ~175ms of module evaluation, and this module is reached for
 * every module a blueprint scans — so importing it eagerly meant an agent paid
 * the compiler's load before knowing whether it had any modules at all.
 *
 * Bound on first use. The helpers below use `ts` as a value and `TsNamespace`
 * for the node types they take, so the one gate in readMeta() serves all of
 * them without changing a signature.
 */
let ts!: typeof TsNamespace
let loading: Promise<void> | null = null
function loadTs(): Promise<void> {
    loading ??= import("typescript").then(mod => { ts = mod.default })
    return loading
}

/**
 * Static metadata of one module.config.ts — automerge flag, env schema,
 * options schema. AST only; module code is never executed at scan time.
 */
export type ModuleMeta = {
    /** null = not declared (defaults to true downstream). */
    automerge: boolean | null
    env: Record<string, { required: boolean; description?: string }>
    optionsSchema: Record<string, ModuleOptionSchema>
}

export async function readMeta(configPath: string): Promise<ModuleMeta> {
    const meta: ModuleMeta = { automerge: null, env: {}, optionsSchema: {} }

    const content = await fsx.readText(configPath)
    if (content === null) return meta

    await loadTs()
    const src = ts.createSourceFile(configPath, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

    function visit(node: TsNamespace.Node) {
        if (
            ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === "defineModule" &&
            node.arguments[0] &&
            ts.isObjectLiteralExpression(node.arguments[0])
        ) {
            const arg = node.arguments[0]
            meta.automerge = boolProp(arg, "automerge")

            const envObj = objectProp(arg, "env")
            if (envObj) meta.env = readEnvSchema(envObj)

            const optionsObj = objectProp(arg, "options")
            if (optionsObj) meta.optionsSchema = readOptionsSchema(optionsObj)
        }
        ts.forEachChild(node, visit)
    }

    ts.forEachChild(src, visit)
    return meta
}

// ─── Object-literal readers ───────────────────────────────────────────────────

function propKey(prop: TsNamespace.ObjectLiteralElementLike): string | null {
    if (!ts.isPropertyAssignment(prop)) return null
    if (ts.isIdentifier(prop.name)) return prop.name.text
    if (ts.isStringLiteral(prop.name)) return prop.name.text
    return null
}

/**
 * Strip `as const` / `as T` and parenthesised wrappers to reach the literal.
 * The module authoring style writes `type: "boolean" as const`, so every
 * reader below must see through the AsExpression or it reads the wrong shape
 * (e.g. a boolean option's type silently falling back to "string").
 */
function unwrap(node: TsNamespace.Expression): TsNamespace.Expression {
    let current = node
    while (ts.isAsExpression(current) || ts.isParenthesizedExpression(current) || ts.isSatisfiesExpression(current)) {
        current = current.expression
    }
    return current
}

function boolProp(obj: TsNamespace.ObjectLiteralExpression, key: string): boolean | null {
    for (const prop of obj.properties) {
        if (propKey(prop) !== key || !ts.isPropertyAssignment(prop)) continue
        const init = unwrap(prop.initializer)
        if (init.kind === ts.SyntaxKind.TrueKeyword) return true
        if (init.kind === ts.SyntaxKind.FalseKeyword) return false
    }
    return null
}

function stringProp(obj: TsNamespace.ObjectLiteralExpression, key: string): string | null {
    for (const prop of obj.properties) {
        if (propKey(prop) !== key || !ts.isPropertyAssignment(prop)) continue
        const init = unwrap(prop.initializer)
        if (ts.isStringLiteral(init)) return init.text
    }
    return null
}

function objectProp(obj: TsNamespace.ObjectLiteralExpression, key: string): TsNamespace.ObjectLiteralExpression | null {
    for (const prop of obj.properties) {
        if (propKey(prop) !== key || !ts.isPropertyAssignment(prop)) continue
        if (ts.isObjectLiteralExpression(prop.initializer)) return prop.initializer
    }
    return null
}

function literalValue(nodeIn: TsNamespace.Expression): unknown {
    const node = unwrap(nodeIn)
    if (ts.isStringLiteral(node)) return node.text
    if (ts.isNumericLiteral(node)) return Number(node.text)
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false
    return undefined
}

function readEnvSchema(envObj: TsNamespace.ObjectLiteralExpression): ModuleMeta["env"] {
    const env: ModuleMeta["env"] = {}
    for (const prop of envObj.properties) {
        const key = propKey(prop)
        if (!key || !ts.isPropertyAssignment(prop) || !ts.isObjectLiteralExpression(prop.initializer)) continue
        const required = boolProp(prop.initializer, "required") ?? false
        const description = stringProp(prop.initializer, "description")
        env[key] = { required, ...(description !== null ? { description } : {}) }
    }
    return env
}

const VALID_OPTION_TYPES = new Set(["string", "number", "boolean"])

function readOptionsSchema(optionsObj: TsNamespace.ObjectLiteralExpression): Record<string, ModuleOptionSchema> {
    const schema: Record<string, ModuleOptionSchema> = {}

    for (const prop of optionsObj.properties) {
        const key = propKey(prop)
        if (!key || !ts.isPropertyAssignment(prop) || !ts.isObjectLiteralExpression(prop.initializer)) continue
        const inner = prop.initializer

        const rawType = stringProp(inner, "type") ?? "string"
        const entry: ModuleOptionSchema = {
            type: VALID_OPTION_TYPES.has(rawType) ? (rawType as "string" | "number" | "boolean") : "string",
        }

        const description = stringProp(inner, "description")
        if (description !== null) entry.description = description

        const required = boolProp(inner, "required")
        if (required !== null) entry.required = required

        for (const p of inner.properties) {
            if (propKey(p) !== "default" || !ts.isPropertyAssignment(p)) continue
            const value = literalValue(p.initializer)
            if (value !== undefined) entry.default = value
        }

        for (const p of inner.properties) {
            if (propKey(p) !== "enum" || !ts.isPropertyAssignment(p)) continue
            if (!ts.isArrayLiteralExpression(p.initializer)) continue
            const values = p.initializer.elements.map(literalValue).filter(v => v !== undefined)
            if (values.length > 0) entry.enum = values
        }

        schema[key] = entry
    }

    return schema
}
