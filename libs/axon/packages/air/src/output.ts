import ts from "typescript"
import type { AxonScope } from "@arcforge/types"
import { err } from "@arcforge/err"
import { scopeToDts } from "./scope-dts"

/**
 * Output — the declared shape of a structured response, and its enforcement.
 *
 * ONE string does three jobs, and they cannot drift because all three read
 * the same compiled artifact:
 *
 *   1. checked   — before any inference, so a typo throws at the call site
 *                  rather than costing a model call and a confusing repair.
 *   2. rendered  — into <scope>, so the model sees its target in the same
 *                  language as its tools.
 *   3. enforced  — against the model's own <script>, so a shape mismatch is
 *                  a real TypeScript diagnostic the model can act on.
 *
 * This is the third spelling of the scope, alongside renderScope() (what the
 * model reads) and scopeToDts() (what an editor reads). Same source, same
 * members, different audience — the discipline that keeps them honest is
 * that none of them decides what is in scope; toScope() does, once.
 *
 * WHY A TYPECHECKER RATHER THAN A SCHEMA LIBRARY: the agent's entire
 * model-facing surface is already TypeScript declarations. A schema library
 * would be a second type language in a system that renders one into every
 * context window, plus a dependency in a package published into every agent.
 * Users need learn nothing new, and every schema library can already emit a
 * TypeScript type — so we support all of them by supporting none of them.
 *
 * THE LIMIT, STATED HONESTLY: TypeScript proves a program is well-typed, not
 * that a runtime value has a shape. `JSON.parse(x) as Output` typechecks and
 * can emit anything. We close the reachable escape hatches (see
 * `assertionDiagnostics`) so the only way to produce a mistyped `result` is
 * code that already failed the check — but the guarantee is "the model's
 * code claims this shape", not "the value has this shape".
 */

/** The synthetic names the program uses. Never seen by a user or the model. */
const OUTPUT_TYPE = "__AxonOutput"
// A .ts module, not a .d.ts: an unresolved type reference inside an ambient
// declaration file is not reported, which would let `{ issues: Issue[] }`
// with no Issue reach the model as an unconstrained request. As a module it
// is a hard error, which is the entire point of the pre-flight.
const OUTPUT_FILE = "__axon_output.ts"
const SCOPE_FILE = "__axon_scope.d.ts"
const CHECK_FILE = "__axon_check.ts"

/**
 * The binding the model is told to produce, and the one the check reads.
 * Public because the protocol prose and the <scope> block both name it — a
 * literal typed twice is a literal that drifts.
 */
export const OUTPUT_BINDING = "result"

const COMPILER_OPTIONS: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck: true,
    // The model's script runs in a REPL capsule where any module is
    // reachable by dynamic import. An unresolvable specifier is therefore
    // the capsule's business, not a shape error worth failing a response
    // over — but the output type's OWN references must still resolve, which
    // is why resolution stays on and only the module-not-found code is
    // dropped (see IGNORED_CODES).
    allowJs: true,
    // A structured response is a value, not a program that runs here.
    noEmit: true,
}

/**
 * Diagnostics that are not the model's problem.
 *
 * 2307 — "cannot find module". The script runs in a capsule where modules
 * arrive by dynamic import at runtime; a specifier this program cannot
 * resolve says nothing about whether the response has the right shape, and
 * failing a correct answer over it would be a false rejection.
 */
const IGNORED_CODES = new Set([2307])

/** A diagnostic in the form the model is shown. */
export type OutputDiagnostic = {
    message: string
    line?: number
}

export type OutputOpts = {
    /** The live capsule scope, so an output type may reference a tool's own types. */
    scope: () => AxonScope
}

/**
 * A compiled output type: valid TypeScript, ready to render and to enforce.
 */
export type CompiledOutput = {
    /** The user's original string, for diagnostics and logs. */
    source: string
    /** The declaration the model is shown, appended to <scope>. */
    declaration: string
    /** Typecheck a model script against this type. Empty array means it holds. */
    check(script: string): OutputDiagnostic[]
}

export function Output(opts: OutputOpts) {
    // The virtual filesystem behind the language service. Held across every
    // request so lib files and the scope are parsed once, not per call —
    // which is the difference between a compiler spin-up and a few ms.
    const files = new Map<string, { text: string; version: number }>()

    function write(name: string, text: string): void {
        const existing = files.get(name)
        if (existing?.text === text) return
        files.set(name, { text, version: (existing?.version ?? 0) + 1 })
    }

    // The scope is regenerated per compile rather than cached: a hot reload
    // can replace the capsule's tools at any time, and an output type
    // checked against a stale scope would accept a tool that no longer
    // exists. write() no-ops when the text is unchanged, so the common case
    // costs one string comparison and keeps the parsed file.
    function syncScope(): void {
        write(SCOPE_FILE, scopeToDts(opts.scope()))
    }

    const host: ts.LanguageServiceHost = {
        getScriptFileNames: () => [...files.keys()],
        getScriptVersion: name => String(files.get(name)?.version ?? 0),
        getScriptSnapshot: name => {
            const file = files.get(name)
            if (file) return ts.ScriptSnapshot.fromString(file.text)
            if (!ts.sys.fileExists(name)) return undefined
            const text = ts.sys.readFile(name)
            return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text)
        },
        getCurrentDirectory: () => "/",
        getCompilationSettings: () => COMPILER_OPTIONS,
        getDefaultLibFileName: options => ts.getDefaultLibFilePath(options),
        fileExists: name => files.has(name) || ts.sys.fileExists(name),
        readFile: name => files.get(name)?.text ?? ts.sys.readFile(name),
    }

    const service = ts.createLanguageService(host, ts.createDocumentRegistry())

    /**
     * `any` reaching `result`, caught by asking the checker rather than by
     * reading syntax.
     *
     * This is the hole that opens without anyone writing it: a tool declared
     * `Promise<any>` flows into `result` and every assignability check above
     * succeeds vacuously — `any` is assignable to everything, so a passing
     * check proves nothing at all. Syntax cannot find it, because the `any`
     * is usually in a declaration somewhere else entirely.
     *
     * Reported against the binding rather than the source of the `any`: the
     * model's fix is to narrow what it assigns to `result` (destructure the
     * fields it needs, or annotate), which is work at the binding.
     */
    function unsoundBindingDiagnostics(scriptLines: number): OutputDiagnostic[] {
        const program = service.getProgram()
        const source = program?.getSourceFile(CHECK_FILE)
        if (!program || !source) return []

        const checker = program.getTypeChecker()
        let binding: ts.VariableDeclaration | undefined
        let reassignment: ts.Node | undefined
        let ambient: ts.VariableStatement | undefined

        function visit(node: ts.Node): void {
            if (
                ts.isVariableDeclaration(node)
                && ts.isIdentifier(node.name)
                && node.name.text === OUTPUT_BINDING
            ) {
                binding = node
                // `declare const result: T` states a type and produces no
                // value: it would serialise to undefined, having passed
                // every check.
                const statement = node.parent?.parent
                if (
                    statement
                    && ts.isVariableStatement(statement)
                    && statement.modifiers?.some(m => m.kind === ts.SyntaxKind.DeclareKeyword)
                ) {
                    ambient = statement
                }
            }

            // A later `result = ...` replaces the value that actually gets
            // serialised, so the declaration the assignability check read is
            // no longer what the template renders.
            if (
                ts.isBinaryExpression(node)
                && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
                && ts.isIdentifier(node.left)
                && node.left.text === OUTPUT_BINDING
            ) {
                reassignment = node
            }

            ts.forEachChild(node, visit)
        }
        ts.forEachChild(source, visit)

        // No binding at all is already reported by the assignability check.
        if (!binding) return []

        const at = (node: ts.Node) => Math.min(
            source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
            scriptLines,
        )

        if (ambient) {
            return [{
                message:
                    "`result` is declared but never assigned a value — `declare` states a "
                    + "type without producing anything, so there would be nothing to return. "
                    + "Build the value instead.",
                line: at(ambient),
            }]
        }

        if (reassignment) {
            return [{
                message:
                    "`result` is reassigned after it is declared, so what gets returned is "
                    + "not what was checked. Compute the value first and assign it to "
                    + "`result` once.",
                line: at(reassignment),
            }]
        }

        const type = checker.getTypeAtLocation(binding.name)
        if (!containsAny(type, checker)) return []

        return [{
            message:
                "`result` resolves to `any`, so its shape was never actually checked — "
                + "assign only values whose types are known (destructure the fields you "
                + "need, or annotate them) rather than passing an untyped value through.",
            line: at(binding),
        }]
    }

    function diagnosticsFor(file: string): OutputDiagnostic[] {
        const raw = [
            ...service.getSyntacticDiagnostics(file),
            ...service.getSemanticDiagnostics(file),
        ].filter(d => !IGNORED_CODES.has(d.code))
        return raw.map(d => ({
            message: ts.flattenDiagnosticMessageText(d.messageText, " "),
            ...lineOf(d),
        }))
    }

    return {
        /**
         * Pre-flight. Turns the user's string into a checked type or throws.
         *
         * Throws rather than falling back to an unconstrained request: a bad
         * output string is a programming error, and silently dropping the
         * constraint would return an unvalidated result where the caller
         * asked for a validated one. That is the difference between `output`
         * being a guarantee and being a hint.
         */
        compile(source: string): CompiledOutput {
            const trimmed = source.trim()
            if (!trimmed) {
                throw err("OUTPUT_INVALID", { detail: "the output type is empty" })
            }

            syncScope()

            // Two accepted forms, disambiguated by trying the simpler one.
            // An expression ("{ a: number }", "string[]") is the common case;
            // a declaration block is how a recursive or shared shape is
            // expressed, and names its target `Output` by convention.
            const typeText = asExpression(trimmed) ?? asDeclarations(trimmed)

            // Pre-flight runs in its own file so the type's own references
            // are checked in isolation, before any model script exists.
            write(OUTPUT_FILE, `${typeText}\nexport {}\n`)
            const problems = diagnosticsFor(OUTPUT_FILE)
            if (problems.length > 0) {
                throw err("OUTPUT_INVALID", {
                    detail: problems.map(p => p.message).join("; "),
                    context: { source: trimmed },
                })
            }

            return {
                source: trimmed,
                declaration: modelDeclaration(trimmed),
                check(script: string): OutputDiagnostic[] {
                    syncScope()
                    write(CHECK_FILE, checkSource(script, typeText))

                    // The shape mismatch itself is reported at the appended
                    // assertion — scaffolding the model never saw. Pointing
                    // it back at the last line of the model's own script
                    // keeps every diagnostic addressed to code it can fix.
                    const scriptLines = script.split("\n").length
                    const found = diagnosticsFor(CHECK_FILE).map(d => {
                        if (d.line === undefined || d.line <= scriptLines) return d
                        return { ...d, line: scriptLines }
                    })
                    if (found.length > 0) return found

                    // Only meaningful once the script typechecks: an
                    // assertion in code that is already wrong is noise.
                    const asserted = assertionDiagnostics(files.get(CHECK_FILE)!.text)
                    if (asserted.length > 0) return asserted

                    // Last, because it is the subtlest: the script is
                    // well-typed and honest about its claims, but the value
                    // reaching `result` may still be `any` — in which case
                    // every check above passed vacuously.
                    return unsoundBindingDiagnostics(scriptLines)
                },
            }
        },
    }
}

export type OutputT = ReturnType<typeof Output>

/**
 * The model's script, annotated so its `result` is checked against the type.
 *
 * The script's own text is placed first and verbatim, so diagnostics carry
 * line numbers pointing at code the model actually wrote. Nothing wraps it:
 * a wrapping function would shift every line and turn the capsule's legal
 * top-level `await` into a syntax error.
 *
 * `export {}` makes this a module, which does two necessary things — it
 * brings scopeToDts()'s `declare global` block into scope, and it legalises
 * top-level await. It trails the script, so it shifts no line numbers.
 */
function checkSource(script: string, declaration: string): string {
    return [
        script,
        // The type is INLINED rather than imported. A cross-file import
        // resolving to `any` fails open — every check passes and the
        // enforcement silently checks nothing, which is far worse than no
        // enforcement at all. Inlining makes the type unavoidably present.
        `;${declaration}`,
        `const ${OUTPUT_BINDING}__check: ${OUTPUT_TYPE} = ${OUTPUT_BINDING};`,
        `void ${OUTPUT_BINDING}__check;`,
        "export {}",
        "",
    ].join("\n")
}

/**
 * What the model is shown, in <scope>, beside its tools.
 *
 * The user's OWN type text, verbatim — an expression inlined onto the
 * binding, a declaration block kept intact above it. The model never sees
 * the synthetic `__AxonOutput` name, because a name it cannot read teaches
 * it nothing about the shape it has to produce.
 */
function modelDeclaration(source: string): string {
    if (isExpression(source)) return `declare const ${OUTPUT_BINDING}: ${source}`
    return `${source}\n\ndeclare const ${OUTPUT_BINDING}: Output`
}

/** `{ a: number }` → a type alias, when the string parses as a type expression. */
function asExpression(source: string): string | null {
    const candidate = `type ${OUTPUT_TYPE} = ${source}\n`
    const file = ts.createSourceFile(OUTPUT_FILE, candidate, ts.ScriptTarget.ES2022, false)
    // Parse diagnostics are not on the public type; a clean parse is the
    // signal that this form was the right guess.
    const parseErrors = (file as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics
    if (parseErrors && parseErrors.length > 0) return null
    return candidate
}

/**
 * A declaration block — how a recursive or shared shape is expressed:
 *
 *   type Issue = { file: string, line: number }
 *   type Output = { issues: Issue[] }
 *
 * The target is `Output` by convention. Aliasing rather than renaming keeps
 * the user's own names in every diagnostic the model reads.
 */
function asDeclarations(source: string): string {
    return `${source}\ntype ${OUTPUT_TYPE} = Output\n`
}

/** Whether the string is a type expression rather than a declaration block. */
function isExpression(source: string): boolean {
    return asExpression(source) !== null
}

/**
 * The escape hatches, closed.
 *
 * TypeScript's assignability check proves a program is well-typed; it does
 * NOT prove a runtime value has a shape, because the language has two
 * deliberate ways to lie about a type. Both are ordinary things to write, so
 * both are rejected when an output contract is in force:
 *
 *   ASSERTIONS — `as T`, `<T>x`, and `satisfies T` all tell the checker to
 *   believe a claim it did not verify. `JSON.parse(x) as Output` is the
 *   canonical case: perfectly well-typed, and capable of emitting anything.
 *
 *   `any`      — the wider hole in practice, because it arrives without
 *   anyone writing it: a tool declared `Promise<any>` flows straight into
 *   `result` and every assignability check trivially succeeds. Caught by
 *   asking the CHECKER what the binding resolved to, not by reading syntax —
 *   the `any` is usually somewhere else entirely.
 *
 * `as const` is exempt: it narrows rather than widens, so it can only make a
 * value MORE specific than the checker already proved.
 *
 * This makes the check sound for the paths that actually reach `result`. It
 * is not a sandbox: the capsule is the security boundary, and a model
 * determined to emit a wrong value has paths no typechecker can see. The
 * goal here is that no honest mistake gets through.
 */
function assertionDiagnostics(source: string): OutputDiagnostic[] {
    const file = ts.createSourceFile(CHECK_FILE, source, ts.ScriptTarget.ES2022, true)
    const found: OutputDiagnostic[] = []

    function visit(node: ts.Node): void {
        if (isWideningAssertion(node)) {
            found.push({
                message:
                    `${assertionKeyword(node)} is not allowed when an output type is declared — `
                    + "it asserts a shape rather than producing one. Build the value so its "
                    + "type is inferred.",
                line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
            })
        }
        ts.forEachChild(node, visit)
    }

    ts.forEachChild(file, visit)
    return found
}

/**
 * Whether a type is, or structurally contains, `any`.
 *
 * Recursive because `{ rows: any }` is exactly as unchecked as a bare `any`
 * — the assignability check succeeds on that property without proving
 * anything about it. Walks properties, array/tuple elements, and union and
 * intersection members.
 *
 * `unknown` is deliberately NOT flagged: it is assignable to nothing without
 * narrowing, so a script that reaches `result` with `unknown` has already
 * failed the assignability check with a real message. `any` is the only type
 * that passes vacuously.
 *
 * Depth- and cycle-guarded: a recursive type (`type Tree = { kids: Tree[] }`)
 * would otherwise walk forever.
 */
function containsAny(type: ts.Type, checker: ts.TypeChecker, seen = new Set<ts.Type>(), depth = 0): boolean {
    if (depth > 8 || seen.has(type)) return false
    seen.add(type)

    if (type.flags & ts.TypeFlags.Any) return true

    if (type.isUnionOrIntersection()) {
        return type.types.some(t => containsAny(t, checker, seen, depth + 1))
    }

    // Arrays and tuples carry their element types as type arguments.
    const reference = type as ts.TypeReference
    if (reference.typeArguments?.length) {
        if (reference.typeArguments.some(t => containsAny(t, checker, seen, depth + 1))) return true
    }

    for (const property of checker.getPropertiesOfType(type)) {
        const declaration = property.valueDeclaration ?? property.declarations?.[0]
        if (!declaration) continue
        const propertyType = checker.getTypeOfSymbolAtLocation(property, declaration)
        if (containsAny(propertyType, checker, seen, depth + 1)) return true
    }

    return false
}

/** An assertion that tells the checker to believe something it did not verify. */
function isWideningAssertion(node: ts.Node): boolean {
    if (ts.isAsExpression(node)) return !isConstAssertion(node)
    if (ts.isTypeAssertionExpression(node)) return true
    if (ts.isSatisfiesExpression(node)) return true
    return false
}

function assertionKeyword(node: ts.Node): string {
    if (ts.isSatisfiesExpression(node)) return "`satisfies`"
    return "a type assertion"
}

function isConstAssertion(node: ts.AsExpression): boolean {
    return ts.isTypeReferenceNode(node.type)
        && ts.isIdentifier(node.type.typeName)
        && node.type.typeName.text === "const"
}

function lineOf(d: ts.Diagnostic): { line?: number } {
    if (d.file === undefined || d.start === undefined) return {}
    return { line: d.file.getLineAndCharacterOfPosition(d.start).line + 1 }
}
