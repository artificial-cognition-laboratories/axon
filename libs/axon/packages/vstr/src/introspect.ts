import ts from "typescript"
import { readFileSync } from "fs"
import { resolve } from "path"
import { parse } from "@vue/compiler-sfc"

export type PropInfo = {
    name: string
    type: string
    required: boolean
    default: unknown
}

/**
 * Introspect a .vue / .prompt SFC and return its prop definitions.
 * Uses the TypeScript AST to parse defineProps<{...}>() from <script setup>.
 * Does not compile or execute the file.
 */
export function introspect(filePath: string): PropInfo[] {
    const abs = resolve(filePath)
    const source = readFileSync(abs, "utf-8")
    return introspectSource(source, abs)
}

/**
 * Introspect props from a source string directly.
 */
export function introspectSource(source: string, filename = "<source>"): PropInfo[] {
    const { descriptor, errors } = parse(source, { filename })
    if (errors.length || !descriptor.scriptSetup) return []

    const scriptContent = descriptor.scriptSetup.content
    const defaults = extractDestructureDefaults(scriptContent)
    const props = extractVueProps(scriptContent)

    for (const prop of props) {
        if (prop.name in defaults) {
            prop.default = defaults[prop.name]
        } else if (!prop.required) {
            prop.default = null
        }
    }

    return props
}

// ── TS AST prop extraction ────────────────────────────────────────────────

function extractVueProps(scriptContent: string): PropInfo[] {
    const src = ts.createSourceFile(
        "props.ts",
        scriptContent,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS
    )
    const props: PropInfo[] = []

    function visit(node: ts.Node) {
        if (
            ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === "defineProps" &&
            node.typeArguments &&
            node.typeArguments.length > 0
        ) {
            const typeArg = node.typeArguments[0]!
            if (ts.isTypeLiteralNode(typeArg)) {
                for (const member of typeArg.members) {
                    if (ts.isPropertySignature(member) && ts.isIdentifier(member.name)) {
                        props.push({
                            name: member.name.text,
                            type: member.type ? member.type.getText(src) : "unknown",
                            required: !member.questionToken,
                            default: undefined,
                        })
                    }
                }
            }
        }
        ts.forEachChild(node, visit)
    }

    ts.forEachChild(src, visit)
    return props
}

function extractDestructureDefaults(src: string): Record<string, unknown> {
    const defaults: Record<string, unknown> = {}
    const match = src.match(/const\s*\{([^}]+)\}\s*=\s*defineProps/)
    if (match?.[1] === undefined) return defaults

    for (const entry of match[1].split(",")) {
        const eqIdx = entry.indexOf("=")
        if (eqIdx === -1) continue
        const propName = entry.slice(0, eqIdx).trim()
        const rawDefault = entry.slice(eqIdx + 1).trim()
        try {
            defaults[propName] = JSON.parse(rawDefault)
        } catch {
            defaults[propName] = rawDefault
        }
    }

    return defaults
}
