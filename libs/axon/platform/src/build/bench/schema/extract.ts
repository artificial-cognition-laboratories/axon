import ts from "typescript"
import { err } from "@arcforge/err"
import type { BenchMeasurementDefinition, BenchMeasurementReducer, BenchMeasurementValueDefinition } from "@arcforge/types"

/**
 * Read the measurement schema out of `defineBench<Schema>(...)`.
 *
 * The schema is authored as a TypeScript type because that is the right tool
 * for describing types — a doc comment is where a description naturally lives,
 * and a union is how anyone would write a fixed set of categories. Modelling
 * the same thing in JSON means building a worse TypeScript inside a config file.
 *
 * But a type is erased at compile time, and two things need the schema as a
 * VALUE at runtime: coverage cannot report "expected four, observed three"
 * unless it knows the fourth exists, and results only enter a shared aggregate
 * when their schemas hash equal. So the type is extracted here, once, at
 * prepare — the author writes a type, the system keeps a value.
 */

const COMPILER_OPTIONS: ts.CompilerOptions = {
    allowJs: false,
    noEmit: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    strict: true,
}

/** Aggregation follows from the kind unless the author says otherwise. */
const DEFAULT_AGGREGATE: Record<BenchMeasurementValueDefinition["kind"], BenchMeasurementReducer> = {
    boolean: "rate",
    number: "mean",
    category: "count",
    text: "last",
}

export function extractBenchSchema(configPath: string): BenchMeasurementDefinition[] {
    const program = ts.createProgram([configPath], COMPILER_OPTIONS)
    const source = program.getSourceFile(configPath)
    if (!source) throw err("BENCH_SCHEMA_UNREADABLE", { detail: configPath, context: { configPath } })

    const checker = program.getTypeChecker()
    const call = findDefineBenchCall(source)

    // No type argument is legal: a benchmark that records nothing still runs.
    // An EMPTY schema and a FAILED extraction must never look the same, which
    // is why this returns [] here and throws everywhere else.
    if (!call?.typeArguments?.length) return []

    const type = checker.getTypeFromTypeNode(call.typeArguments[0]!)
    const properties = checker.getPropertiesOfType(type)
    if (properties.length === 0) {
        throw err("BENCH_SCHEMA_EMPTY", {
            detail: "defineBench<Schema> was given a type with no properties — declare at least one measurement or drop the type argument",
            context: { configPath },
        })
    }

    return properties.map(property => toMeasurement(property, checker, configPath))
}

function findDefineBenchCall(source: ts.SourceFile): ts.CallExpression | null {
    let found: ts.CallExpression | null = null
    const visit = (node: ts.Node): void => {
        if (found) return
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "defineBench") {
            found = node
            return
        }
        ts.forEachChild(node, visit)
    }
    ts.forEachChild(source, visit)
    return found
}

function toMeasurement(
    property: ts.Symbol,
    checker: ts.TypeChecker,
    configPath: string,
): BenchMeasurementDefinition {
    const id = property.getName()
    const declaration = property.valueDeclaration ?? property.declarations?.[0]
    const type = declaration
        ? checker.getTypeOfSymbolAtLocation(property, declaration)
        : checker.getDeclaredTypeOfSymbol(property)

    const value = toValueDefinition(type, checker, id, configPath)
    const description = ts.displayPartsToString(property.getDocumentationComment(checker)).trim()
    const tags = Object.fromEntries(
        property.getJsDocTags(checker).map(tag => [tag.name, ts.displayPartsToString(tag.text).trim()]),
    )

    return {
        id,
        // The property name is the label unless the author overrides it: an id
        // is already a human-chosen word, so restating it is pure ceremony.
        label: tags.label || sentenceCase(id),
        description,
        value: tags.unit && value.kind === "number" ? { ...value, unit: tags.unit } : value,
        aggregate: (tags.aggregate as BenchMeasurementReducer | undefined) ?? DEFAULT_AGGREGATE[value.kind],
        ...(tags.objective ? { objective: parseObjective(tags.objective, id, configPath) } : {}),
        ...(tags.required === "" || tags.required === "true" ? { required: true } : {}),
    }
}

function toValueDefinition(
    type: ts.Type,
    checker: ts.TypeChecker,
    id: string,
    configPath: string,
): BenchMeasurementValueDefinition {
    if (type.flags & ts.TypeFlags.BooleanLike) return { kind: "boolean" }
    if (type.flags & ts.TypeFlags.NumberLike) return { kind: "number" }

    // A union of string literals is a category with a closed value set — the
    // natural way to write "one of these", and the reason the schema is a type.
    if (type.isUnion()) {
        const literals = type.types.filter(member => member.isStringLiteral())
        if (literals.length === type.types.length && literals.length > 0) {
            return { kind: "category", values: literals.map(member => (member as ts.StringLiteralType).value) }
        }
        if (type.types.every(member => member.flags & ts.TypeFlags.BooleanLike)) return { kind: "boolean" }
    }

    if (type.flags & ts.TypeFlags.StringLike) return { kind: "text" }

    throw err("BENCH_SCHEMA_UNSUPPORTED_TYPE", {
        detail: `measurement ${JSON.stringify(id)} is ${checker.typeToString(type)} — measurements are boolean, number, a union of string literals, or string`,
        context: { configPath, measurementId: id, type: checker.typeToString(type) },
    })
}

function parseObjective(raw: string, id: string, configPath: string) {
    const value = raw.trim()
    if (value === "maximize" || value === "minimize") return value
    const target = /^target\s+(-?\d+(?:\.\d+)?)$/.exec(value)
    if (target) return { target: Number(target[1]) }
    throw err("BENCH_SCHEMA_UNSUPPORTED_TYPE", {
        detail: `measurement ${JSON.stringify(id)} has @objective ${JSON.stringify(value)} — expected "maximize", "minimize", or "target <n>"`,
        context: { configPath, measurementId: id },
    })
}

function sentenceCase(id: string): string {
    const spaced = id.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2")
    return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}
