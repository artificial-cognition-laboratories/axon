import type ts from "typescript"

/**
 * The TypeScript compiler, loaded on FIRST USE rather than at import.
 *
 * `typescript` costs ~190-220ms to load, and it was being pulled into every
 * `axon` invocation through this module's import chain — before argument
 * parsing, before any command ran, before a character reached the screen.
 * `axon dev` showing nothing for a second was largely this.
 *
 * Nothing here touches `ts` at module scope; every reference is inside a
 * function body. So deferring costs the first caller the load and every
 * command that parses no source file nothing at all.
 *
 * `require`, not `await import`: these APIs are synchronous and making them
 * async would ripple through every caller for no gain. The type import above
 * is erased at compile time, which keeps every `ts.X` annotation unchanged.
 */
let _ts: typeof ts | undefined
function tsc(): typeof ts {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- see above
    return (_ts ??= require("typescript") as typeof ts)
}

import { err } from "@arcforge/err"

/**
 * Resolve every type an exported tool signature names, and render each one's
 * declaration text for inlining into the agent's scope.
 *
 * THE RULE THIS IMPLEMENTS: the author's declaration is the contract. What
 * they wrote in the signature is what the model is shown — this module has no
 * opinion on whether a shape was a good idea, only on whether it can be
 * rendered faithfully. A scan fails when a named type genuinely cannot be
 * resolved, and at no other time.
 *
 * WHY THE CHECKER AND NOT THE EMITTED TEXT. The previous resolver collected
 * declarations by walking the emitted `.d.ts` for top-level `interface`/`type`
 * nodes and decided what was referenced with a `\bName\b` regex over the
 * declaration string. That approach is structurally incapable of answering the
 * questions authors actually ask of it, because none of them are answerable
 * from declaration text:
 *
 *   - `export type { RecallResponse } from "@vectorize-io/hindsight-client"`
 *     emits verbatim and declares nothing locally, so the re-export was
 *     invisible and the error told the author to write the line their source
 *     already had.
 *   - `Pick<Response, "items">` and `Response["items"]` keep the parent name in
 *     the emitted text, so narrowing an external type — the very pattern worth
 *     encouraging — failed.
 *   - An UNANNOTATED tool returning the same external type passed, because tsc
 *     emits `import("pkg").Response` and no bare identifier ever appears. The
 *     gate rewarded deleting type annotations, and the laundered form was
 *     strictly worse for the model: same type, now opaque.
 *   - A resolved type's own field types were never followed, so `type Big = {
 *     b: Deep }` inlined `Big` and left `Deep` dangling in the model's context.
 *
 * Asking the checker collapses all four into one implementation: walk the type
 * the checker actually resolved, collect the declaration behind every symbol
 * encountered, recurse. They stop being edge cases and become consequences.
 *
 * TERMINATION. Following a type graph must stop somewhere or it inlines half of
 * lib.dom.d.ts. Lib types (`Date`, `Array`, `Promise`, primitives) are leaves —
 * the model already knows them and their declarations are enormous. Everything
 * else is followed until it bottoms out, with a seen-set carrying recursion
 * (`type Node = { children: Node[] }` resolves to one declaration, not a hang).
 */

/** One resolved type: its name, and the declaration text to inline. */
export type ResolvedType = {
    name: string
    /** Declaration text with `export`/`declare` stripped — inlined into an ambient block. */
    text: string
}

export type ResolveOpts = {
    checker: ts.TypeChecker
    /** The tool file being declared, named in any error raised. */
    fileName: string
}

/**
 * Symbols whose declarations must never be inlined.
 *
 * These are the leaves of the walk. A lib type is one TypeScript itself
 * declares — the model knows `Date` and `Array` without being told, and
 * `lib.es5.d.ts`'s `Array<T>` declaration alone is several hundred lines.
 */
function isLibSymbol(symbol: ts.Symbol): boolean {
    const declarations = symbol.getDeclarations()
    if (!declarations || declarations.length === 0) return true
    // ANY declaration in a lib file makes this a leaf, not every one.
    //
    // `Array` is declared across lib.es5, lib.es2015.core, lib.es2015.iterable
    // and more — TypeScript merges them into one symbol. An `.every()` test
    // therefore answered false the moment a single declaration sat in a file
    // the predicate did not recognise, and the walk inlined the entire
    // `interface Array<T>` — hundreds of lines of methods — into the model's
    // context. Global types are global: one lib declaration is proof enough.
    return declarations.some(d => isLibFile(d.getSourceFile()))
}

/** True for one of TypeScript's own lib.*.d.ts files. */
function isLibFile(file: ts.SourceFile): boolean {
    return file.hasNoDefaultLib
        || /[\\/]typescript[\\/]lib[\\/]lib\.[^\\/]*\.d\.ts$/.test(file.fileName)
        || /[\\/]typescript[\\/]lib[\\/]lib\.d\.ts$/.test(file.fileName)
}

/**
 * Strip the module-level markers from a declaration so it can be inlined.
 *
 * Both consumers (the model's `<scope>` block and tool-globals.d.ts) drop these
 * into an ambient `declare global` context, where `export` is meaningless and a
 * nested `declare` is a syntax error (TS1038).
 */
function inlineable(text: string): string {
    return text.trim().replace(/^export\s+default\s+/, "").replace(/^export\s+/, "").replace(/^declare\s+/, "")
}

/**
 * The declaration node to render for a symbol, following aliases.
 *
 * An `export { X } from "pkg"` / `import type { X }` binding resolves to an
 * ALIAS symbol whose own declaration is the import statement, not the type. The
 * text of that statement is useless to the model — it names a module the agent
 * cannot resolve. `getAliasedSymbol` walks to the real declaration, which is
 * what makes a re-exported package type render as its actual shape.
 */
function targetSymbol(symbol: ts.Symbol, checker: ts.TypeChecker): ts.Symbol {
    if ((symbol.flags & tsc().SymbolFlags.Alias) === 0) return symbol
    try {
        const aliased = checker.getAliasedSymbol(symbol)
        return aliased.getDeclarations()?.length ? aliased : symbol
    } catch {
        // getAliasedSymbol throws on a symbol that is not actually an alias
        // target (a malformed or unresolvable import). Falling back to the
        // symbol itself is correct: the caller then finds no renderable
        // declaration and fails loudly, which is the right outcome for an
        // import that does not resolve.
        return symbol
    }
}

/** The node whose text is the type's declaration, or undefined if it has none worth inlining. */
function declarationNode(symbol: ts.Symbol): ts.Declaration | undefined {
    const declarations = symbol.getDeclarations() ?? []
    for (const declaration of declarations) {
        if (
            tsc().isInterfaceDeclaration(declaration)
            || tsc().isTypeAliasDeclaration(declaration)
            || tsc().isClassDeclaration(declaration)
            || tsc().isEnumDeclaration(declaration)
        ) {
            return declaration
        }
    }
    return undefined
}

/**
 * Every type-name identifier inside a declaration, as the CHECKER resolves it.
 *
 * This is the recursion step, and it is deliberately syntactic-walk +
 * checker-lookup rather than a walk over `ts.Type`. A `ts.Type` has already
 * been normalized — `Pick<R, "a">` becomes an anonymous object type and the
 * name `R` is gone — but the text being inlined still SAYS `Pick<R, "a">`, so
 * the model needs `R`. Walking the syntax keeps rendered text and collected
 * types in agreement, which is the invariant that matters: every name in an
 * inlined declaration must itself be inlined.
 */
function referencedSymbols(node: ts.Node, checker: ts.TypeChecker): ts.Symbol[] {
    const found: ts.Symbol[] = []

    function visit(current: ts.Node): void {
        // An `export { T } from "…"` specifier IS the reference — its name is a
        // plain identifier, not a type-reference node, so the type-position
        // cases below never see it. This is the form an author uses to say "this
        // package type is part of what I expose", and honouring it is the whole
        // point of accepting the re-export.
        if (tsc().isExportSpecifier(current)) {
            const symbol = checker.getSymbolAtLocation(current.name)
            if (symbol) found.push(symbol)
            return
        }
        // The NAME of the declaration itself is not a reference to anything.
        if (tsc().isTypeReferenceNode(current)) {
            const name = tsc().isQualifiedName(current.typeName) ? current.typeName.right : current.typeName
            const symbol = checker.getSymbolAtLocation(name)
            if (symbol) found.push(symbol)
        } else if (tsc().isExpressionWithTypeArguments(current) && tsc().isIdentifier(current.expression)) {
            // `interface A extends B` / `class A implements B` — B is a real
            // reference the model needs, and it is not a TypeReferenceNode.
            const symbol = checker.getSymbolAtLocation(current.expression)
            if (symbol) found.push(symbol)
        } else if (tsc().isTypeQueryNode(current)) {
            // `typeof x` — the thing being queried is referenced.
            const name = tsc().isQualifiedName(current.exprName) ? current.exprName.right : current.exprName
            const symbol = checker.getSymbolAtLocation(name)
            if (symbol) found.push(symbol)
        }
        tsc().forEachChild(current, visit)
    }

    // Skip the declaration's own name so `type Node = ...` does not resolve
    // itself as a reference on the first step.
    tsc().forEachChild(node, child => {
        if ((tsc().isInterfaceDeclaration(node) || tsc().isTypeAliasDeclaration(node) || tsc().isClassDeclaration(node) || tsc().isEnumDeclaration(node)) && child === node.name) return
        visit(child)
    })

    return found
}

/**
 * Resolve one entry point — a type name appearing in an exported signature —
 * and everything it transitively names.
 *
 * `seen` is shared across every entry point in a file so a type referenced by
 * two tools is collected once, and so a cycle terminates.
 */
function collect(symbol: ts.Symbol, opts: ResolveOpts, seen: Map<ts.Symbol, ResolvedType | null>, out: ResolvedType[]): void {
    const target = targetSymbol(symbol, opts.checker)
    if (seen.has(target)) return

    if (isLibSymbol(target)) {
        // A leaf. Recorded so a second encounter does not re-walk it.
        seen.set(target, null)
        return
    }

    const declaration = declarationNode(target)
    if (!declaration) {
        // Not a type the model needs (a value import, a namespace), or a type
        // with no renderable declaration. Type PARAMETERS land here too and are
        // correctly skipped — `T` in `id<T>(x: T): T` is bound by the signature
        // that carries it, not a type to inline.
        seen.set(target, null)
        return
    }

    // Reserve the slot BEFORE recursing so a self-referential type
    // (`type Node = { children: Node[] }`) terminates on its own name.
    seen.set(target, null)

    const source = declaration.getSourceFile()
    const resolved: ResolvedType = {
        name: target.getName(),
        text: inlineable(declaration.getFullText(source).replace(/^\s*\/\*\*[\s\S]*?\*\/\s*/, "")),
    }
    seen.set(target, resolved)
    out.push(resolved)

    for (const referenced of referencedSymbols(declaration, opts.checker)) {
        collect(referenced, opts, seen, out)
    }
}

/**
 * Every type named by the given signature nodes, transitively, ready to inline.
 *
 * Order is first-encountered, which puts a tool's own top-level types ahead of
 * the internals they reference — the order a reader (and a model) wants.
 */
export function resolveSignatureTypes(nodes: ts.Node[], opts: ResolveOpts): ResolvedType[] {
    const seen = new Map<ts.Symbol, ResolvedType | null>()
    const out: ResolvedType[] = []

    for (const node of nodes) {
        // An export specifier is itself the reference; everything else is a
        // container whose type positions are walked.
        if (tsc().isExportSpecifier(node)) {
            const symbol = opts.checker.getSymbolAtLocation(node.name)
            if (symbol) collect(symbol, opts, seen, out)
            continue
        }
        for (const symbol of referencedSymbols(node, opts.checker)) {
            collect(symbol, opts, seen, out)
        }
    }

    return out
}

/**
 * Fail on any type name in a rendered declaration with nothing behind it.
 *
 * The invariant every consumer depends on: a name the model reads in a
 * signature resolves to a declaration in the same context block. A dangling
 * name is the silent-wrong-output failure this whole seam exists to prevent —
 * the model reads `Promise<Roll>` with no `Roll` anywhere and the editor block
 * does not compile.
 *
 * Checked against RENDERED text rather than the symbol walk because that is
 * what actually ships. If the two ever disagree, the text is the thing the
 * model sees, so the text is what must be verified.
 */
export function assertNoDanglingTypes(declarations: string[], resolved: ResolvedType[], fileName: string): void {
    const known = new Set(resolved.map(r => r.name))

    for (const declaration of declarations) {
        // Parse the rendered declaration and check every type name it uses.
        //
        // A regex over the text cannot do this job: it cannot tell a type
        // position from a parameter name or a property key, and it would reject
        // `opts` as readily as `Missing`. Parsing gives exact type positions,
        // which is what makes it safe to fail on what is left.
        for (const name of typeNamesIn(declaration)) {
            if (known.has(name) || isGlobalTypeName(name)) continue
            throw err("TOOL_DECLARE_FAILED", {
                detail: `type "${name}" is used in an exported signature but has no resolvable definition`
                    + ` — re-export it (\`export type { ${name} } from "…"\`) so the agent can read the type it is given`,
                context: { file: fileName, type: name },
            })
        }

        for (const match of declaration.matchAll(/\bimport\(["'][^"']+["']\)\s*\.\s*(\w+)/g)) {
            const name = match[1] ?? ""
            // An unresolved `import("pkg").Type` is the laundered-inference
            // failure: the author omitted an annotation, tsc emitted a module
            // path, and the model gets a name it cannot resolve. If the walk
            // DID resolve it, the declaration is fine and only its spelling
            // needs rewriting (see rewriteImportPaths) — this is the case where
            // it did not.
            if (!known.has(name)) {
                throw err("TOOL_DECLARE_FAILED", {
                    detail: `type "${name}" is used in an exported signature but its definition does not travel with the tool`
                        + ` — re-export it (\`export type { ${name} } from "…"\`) so the agent can read the type it is given`,
                    context: { file: fileName, type: name },
                })
            }
        }
    }
}

/**
 * Rewrite `import("pkg").Type` to the bare `Type` the resolved set declares.
 *
 * tsc emits a module path whenever a type reaches a signature without a local
 * name — most often an unannotated return whose type came from an import. The
 * path is correct TypeScript and useless output: the model cannot resolve the
 * specifier, and the generated tool-globals.d.ts would need the package on disk
 * to compile. Since the walk has already collected the declaration and it is
 * inlined alongside, the bare name is both shorter and actually resolvable.
 *
 * Only names present in `resolved` are rewritten. Anything else is left exactly
 * as tsc wrote it so assertNoDanglingTypes can see and report it.
 */
export function rewriteImportPaths(declaration: string, resolved: ResolvedType[]): string {
    const known = new Set(resolved.map(r => r.name))
    return declaration.replace(/\bimport\(["'][^"']+["']\)\s*\.\s*(\w+)/g, (whole, name: string) =>
        known.has(name) ? name : whole,
    )
}

/**
 * Every identifier used in a TYPE POSITION inside a rendered declaration.
 *
 * Parsed, not matched. The declaration is wrapped in `declare` and read as a
 * .d.ts so the compiler's own parser marks the type positions — the same
 * distinction a regex cannot make, which is why the old resolver's
 * `\bName\b` test could not be trusted to decide anything.
 *
 * Type PARAMETERS are excluded: `T` in `function id<T>(x: T): T` is bound by
 * the signature carrying it, so it is resolvable without being inlined.
 */
function typeNamesIn(declaration: string): string[] {
    const src = tsc().createSourceFile("d.d.ts", `declare ${declaration};`, tsc().ScriptTarget.Latest, true, tsc().ScriptKind.TS)
    const names: string[] = []
    const bound = new Set<string>()

    function visit(node: ts.Node): void {
        if (tsc().isTypeParameterDeclaration(node)) bound.add(node.name.getText(src))
        if (tsc().isTypeReferenceNode(node)) {
            // Only the LEFTMOST name of a qualified reference is a lookup;
            // `A.B` resolves B within A, so B is not independently declared.
            const root = tsc().isQualifiedName(node.typeName) ? leftmost(node.typeName) : node.typeName
            names.push(root.getText(src))
        }
        tsc().forEachChild(node, visit)
    }
    visit(src)

    return names.filter(name => !bound.has(name))
}

function leftmost(name: ts.QualifiedName): ts.Identifier {
    let current: ts.EntityName = name
    while (tsc().isQualifiedName(current)) current = current.left
    return current
}

/**
 * Type names that resolve without travelling with the tool.
 *
 * These are the leaves isLibSymbol() refused to inline, named again on the text
 * side. The two must agree: a type skipped as a lib global during the walk and
 * then rejected as dangling here would fail every tool that mentions `Date`.
 *
 * Deliberately a fixed list rather than a checker query. This runs over
 * RENDERED TEXT, which has no program behind it — and the set of globals a tool
 * signature can legitimately name is small, stable, and worth stating outright
 * rather than inferring.
 */
const GLOBAL_TYPE_NAMES = new Set([
    "Array", "ReadonlyArray", "Promise", "PromiseLike", "Date", "RegExp", "Error", "Map", "Set",
    "WeakMap", "WeakSet", "Record", "Partial", "Required", "Readonly", "Pick", "Omit", "Exclude",
    "Extract", "NonNullable", "ReturnType", "Parameters", "Awaited", "InstanceType", "ThisType",
    "Iterable", "IterableIterator", "AsyncIterable", "AsyncIterableIterator", "Iterator",
    "ArrayBuffer", "SharedArrayBuffer", "DataView", "Uint8Array", "Uint16Array", "Uint32Array",
    "Int8Array", "Int16Array", "Int32Array", "Float32Array", "Float64Array", "BigInt64Array",
    "BigUint64Array", "Function", "Object", "String", "Number", "Boolean", "Symbol", "BigInt",
    "JSON", "Math", "Generator", "AsyncGenerator", "Buffer", "URL", "URLSearchParams", "Blob",
    "File", "FormData", "Headers", "Request", "Response", "AbortSignal", "ReadableStream",
    "WritableStream", "TransformStream", "Uppercase", "Lowercase", "Capitalize", "Uncapitalize",
    "NoInfer", "Intl",
])

function isGlobalTypeName(name: string): boolean {
    return GLOBAL_TYPE_NAMES.has(name)
}
