import { dirname, join } from "node:path"
import ts from "typescript"
import type { ToolFnEntry } from "@arcforge/types"
import { err } from "@arcforge/err"
import { resolveSignatureTypes, assertNoDanglingTypes, rewriteImportPaths } from "./resolve"

export type DeclaredFile = {
    /** One entry per top-level exported function/const in this file. */
    fns: ToolFnEntry[]
    /** Interface/type-alias/un-exported-helper declarations this file's exports reference, deduped, in first-encountered order. */
    ambientTypes: string[]
}

const COMPILER_OPTIONS: ts.CompilerOptions = {
    declaration: true,
    emitDeclarationOnly: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck: true,
    // Declaration emit fails loudly on an implicit any parameter otherwise —
    // tool authors write plain, unannotated JS-shaped TS; forcing strict
    // parameter typing here would make the SCANNER reject code the runtime
    // happily executes. Emission still infers real return types either way.
    noImplicitAny: false,
    allowImportingTsExtensions: true,
}

/**
 * Real TypeScript declaration emission over a directory of tool source
 * files — replaces hand-rolled AST pattern matching (which could only ever
 * read explicit annotations, rendering "unknown" for anything inferred)
 * with the actual compiler: real inferred types (Promise<string>, not
 * Promise<unknown>), JSDoc preserved verbatim by tsc itself, and any
 * ambient type an exported function references followed and captured.
 *
 * One ts.Program per directory (not per file) — files in the same
 * directory can reference each other's types (a tool importing a shared
 * `type Foo` from a sibling file), and the checker needs the whole set to
 * resolve those correctly.
 *
 * Declarations are FLATTENED: tsc's default output keeps ambient types in
 * their own emitted file with an `import type` back to it (correct, but
 * means a reader has to follow the import). Fleet/the model context both
 * need one self-contained block per tool — see `ambientTypes` on the
 * result, meant to be rendered inline by the caller (renderScope() for
 * the model, tool-globals.d.ts for the IDE), not as a relative import.
 *
 * TWO HALVES, TWO SOURCES. Signatures are read back from the EMITTED .d.ts,
 * because that is where tsc has already resolved inference and JSDoc. The types
 * those signatures name are resolved from the ORIGINAL SOURCE through the
 * checker (resolve.ts), because emitted text has lost the identifiers a
 * resolver needs — a re-export names a module, an unannotated return becomes
 * `import("pkg").T`, and a `Pick<T, "a">` points at a declaration in another
 * file. Reading types out of the emitted text is what made re-exports,
 * narrowing, and transitive fields fail; the split is the fix.
 */
/**
 * TypeScript's own lib.*.d.ts files, parsed once per process.
 *
 * Building a program re-reads and re-parses the entire standard library —
 * about a megabyte of declarations — and that, not the tool source, is where
 * the second is spent: a program over ONE trivial tool file costs ~1.0s, and
 * ~0.07s once these are cached. A caller that declares several roots in one
 * process (the tool scan does, and the test suite does it fifteen times over)
 * pays the full parse once instead of once per root.
 *
 * Deliberately keyed to lib files ONLY. Project sources are excluded because
 * they are exactly what changes between two calls — caching a tool file would
 * serve the previous edit's declarations, which is the silent-wrong-output
 * failure this scanner exists to avoid. The lib cannot change within a
 * process: it ships with the compiler this module already imported.
 */
const libFiles = new Map<string, ts.SourceFile | undefined>()

/** The directory TypeScript's own lib.*.d.ts files ship in. */
const libDir = normalize(ts.getDefaultLibFilePath(COMPILER_OPTIONS).replace(/[^/\\]+$/, ""))

/** True for a path inside TypeScript's own lib directory. */
function isLibFile(fileName: string): boolean {
    return fileName.startsWith(libDir)
}

/**
 * A path TypeScript will emit declarations for.
 *
 * TypeScript treats anything under `node_modules` as EXTERNAL LIBRARY CODE and
 * silently skips declaration emit for it. That is correct for a package that
 * ships its own `.d.ts`, and exactly wrong here: an installed Axon module ships
 * TypeScript SOURCE that the consumer's scanner has to declare in order to
 * build the tool scope.
 *
 * The failure it produced was quiet and misleading. A tool file importing a
 * sibling got one `.d.ts` where it needed two, every type declared in that
 * sibling became unresolvable, and the scanner blamed the author for a missing
 * re-export their source already had (@axon/arxiv, `QueryOptions`).
 *
 * Rewriting the segment is the narrowest fix that works, because it changes
 * only the thing TypeScript keys its decision on. The path stays absolute,
 * unique and structurally identical, so imports resolve exactly as before —
 * and `unshadow` maps every emitted path back before any caller sees it.
 *
 * Prefixed with a NUL-free sentinel unlikely to collide with a real directory:
 * a project genuinely containing `__axon_modules__` would otherwise have two
 * distinct files map to one path.
 */
const NODE_MODULES = "/node_modules/"
const SHADOWED = "/__axon_modules__/"

function shadow(path: string): string {
    return path.split(NODE_MODULES).join(SHADOWED)
}

function unshadow(path: string): string {
    return path.split(SHADOWED).join(NODE_MODULES)
}

export function declareTools(fileNames: string[]): Map<string, DeclaredFile> {
    const emitted = new Map<string, string>()

    const host = ts.createCompilerHost(COMPILER_OPTIONS)

    // Reads follow the shadow back to the real file on disk. Everything above
    // this line thinks in shadowed paths; everything below it, and the whole
    // filesystem, thinks in real ones.
    const realFileExists = host.fileExists.bind(host)
    host.fileExists = fileName => realFileExists(unshadow(fileName))
    const realReadFile = host.readFile.bind(host)
    host.readFile = fileName => realReadFile(unshadow(fileName))
    if (host.realpath) {
        const realRealpath = host.realpath.bind(host)
        // Resolving through realpath would undo the shadow — tsc calls it while
        // resolving modules and would get back a node_modules path, silently
        // reinstating the emit skip this exists to avoid.
        host.realpath = fileName => shadow(realRealpath(unshadow(fileName)))
    }
    const realDirectoryExists = host.directoryExists?.bind(host)
    if (realDirectoryExists) host.directoryExists = dir => realDirectoryExists(unshadow(dir))
    const realGetDirectories = host.getDirectories?.bind(host)
    if (realGetDirectories) host.getDirectories = dir => realGetDirectories(unshadow(dir))
    const realReadDirectory = host.readDirectory?.bind(host)
    if (realReadDirectory) {
        host.readDirectory = (dir, extensions, exclude, include, depth) =>
            realReadDirectory(unshadow(dir), extensions, exclude, include, depth).map(shadow)
    }

    // Serve lib declarations from the process-wide cache; everything else
    // reads from disk exactly as before.
    const readSourceFile = host.getSourceFile.bind(host)
    host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
        if (!isLibFile(normalize(unshadow(fileName)))) {
            // Read the real file, but hand tsc a SourceFile whose name is the
            // shadowed path — the name is what emit keys on, so it has to be
            // the one that is not under node_modules.
            const parsed = readSourceFile(unshadow(fileName), languageVersion, onError, shouldCreate)
            if (parsed && parsed.fileName !== fileName) {
                Object.defineProperty(parsed, "fileName", { value: fileName, configurable: true })
            }
            return parsed
        }
        const cached = libFiles.get(fileName)
        if (cached !== undefined || libFiles.has(fileName)) return cached

        const parsed = readSourceFile(fileName, languageVersion, onError, shouldCreate)
        libFiles.set(fileName, parsed)
        return parsed
    }
    // Keyed on the normalized path: tsc resolves every internal path to forward
    // slashes with `.`/`..` segments collapsed, and calls writeFile with THAT,
    // not with the string it was handed. A lookup keyed on the raw input then
    // misses for any path that is merely spelled differently — "/a/./b.ts", or
    // a Windows path carrying backslashes. That miss used to be answered with
    // `continue`, so the file silently vanished from the result and the scan
    // reported a successful empty declaration set.
    // Emitted paths are mapped back, so every caller sees real locations.
    host.writeFile = (fileName, text) => emitted.set(normalize(unshadow(fileName)), text)

    const program = ts.createProgram(fileNames.map(shadow), COMPILER_OPTIONS, host)
    program.emit()
    const result = new Map<string, DeclaredFile>()

    const checker = program.getTypeChecker()

    // The emitted .d.ts of each file, parsed. Used ONLY to read back the
    // signatures tsc inferred (extractFnEntries) — type RESOLUTION works from
    // the original source via the checker, since emitted text has already lost
    // the identifiers a resolver needs. See resolve.ts.
    const emittedSources = new Map<string, ts.SourceFile>()
    for (const [file, text] of emitted) {
        emittedSources.set(file, ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS))
    }

    for (const fileName of fileNames) {
        const normalized = normalize(fileName)
        const dtsPath = declarationPathFor(normalized)
        const src = emittedSources.get(dtsPath)

        // No declaration emitted for a file we were asked to declare. The file
        // does not exist, does not compile, or its imports do not resolve —
        // every one of which means the agent's scope is not what the author
        // wrote. There is no partial success to return here: a scan that
        // silently omits a tool produces an agent the model was never told
        // about, and the caller caches that emptiness against the source hash,
        // so it survives every reboot until the file changes.
        if (!src) {
            throw err("TOOL_DECLARE_FAILED", {
                detail: `${fileName}: no TypeScript declaration could be emitted — the file is missing, does not compile, or has an unresolvable import${diagnosticsFor(program, fileName)}`,
                context: { file: fileName },
            })
        }

        const rawFns = extractFnEntries(src)

        // Types are resolved from the ORIGINAL SOURCE, not the emitted .d.ts.
        //
        // The emitted file is text that has already lost what the resolver
        // needs: a re-export line names a module rather than a shape, an
        // unannotated return becomes `import("pkg").T`, and a `Pick<T, "a">`
        // keeps a name whose declaration lives in another program file. The
        // source still carries real identifiers the checker can resolve, so
        // that is what gets walked. See resolve.ts for the full reasoning.
        const sourceFile = program.getSourceFile(shadow(normalized))
        if (!sourceFile) {
            throw err("TOOL_DECLARE_FAILED", {
                detail: `${fileName}: the file was emitted but is not in the program — this is a scanner bug, not an author error`,
                context: { file: fileName },
            })
        }

        const signatures = exportedSignatureNodes(sourceFile)
        const resolved = resolveSignatureTypes(signatures, { checker, fileName })

        // tsc spells an unnamed imported type as `import("pkg").T`. Where the
        // walk resolved it, the declaration is inlined beside this signature,
        // so the bare name is what the model should read.
        const fns = rawFns.map(fn => ({ ...fn, declaration: rewriteImportPaths(fn.declaration, resolved) }))

        // What actually ships is the rendered text; verify THAT rather than the
        // walk that produced it. A name the model reads with nothing behind it
        // is the silent-wrong-output failure this seam exists to prevent.
        assertNoDanglingTypes(fns.map(fn => fn.declaration), resolved, fileName)

        result.set(fileName, { fns, ambientTypes: resolved.map(r => r.text) })
    }

    return result
}

/**
 * The nodes whose type references make up a file's public surface.
 *
 * Exactly the exported functions, exported variables (an arrow const, or an
 * object of methods — the `export const hindsight = { … }` shape), and exported
 * classes. Everything a tool's caller can name lives in one of these, and
 * nothing else in the file is part of the contract.
 *
 * Type-only exports are included deliberately: `export type { RecallResponse }
 * from "pkg"` is an author stating that this type is part of what they expose,
 * and honouring that statement is the whole point of the re-export form.
 */
function exportedSignatureNodes(src: ts.SourceFile): ts.Node[] {
    const nodes: ts.Node[] = []

    ts.forEachChild(src, node => {
        if (ts.isFunctionDeclaration(node) && hasExportModifier(node)) {
            nodes.push(node)
        } else if (ts.isClassDeclaration(node) && hasExportModifier(node)) {
            nodes.push(node)
        } else if (ts.isVariableStatement(node) && hasExportModifier(node)) {
            nodes.push(node)
        } else if (ts.isTypeAliasDeclaration(node) && hasExportModifier(node)) {
            nodes.push(node)
        } else if (ts.isInterfaceDeclaration(node) && hasExportModifier(node)) {
            nodes.push(node)
        } else if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
            for (const element of node.exportClause.elements) nodes.push(element)
        }
    })

    return nodes
}

/**
 * tsc's normalized spelling of a path: forward slashes, `.`/`..` collapsed.
 * The single source of truth for how `emitted` is keyed and looked up — the two
 * must use the same function or the lookup misses on nothing but spelling.
 */
function normalize(path: string): string {
    return ts.sys.resolvePath(path.replace(/\\/g, "/"))
}

/** Compiler diagnostics for one file, appended to an error so the message says WHY. */
function diagnosticsFor(program: ts.Program, fileName: string): string {
    const source = program.getSourceFile(fileName) ?? program.getSourceFile(normalize(fileName))
    if (!source) return ""
    const messages = program
        .getSemanticDiagnostics(source)
        .concat(program.getSyntacticDiagnostics(source))
        .map(d => ts.flattenDiagnosticMessageText(d.messageText, " "))
    return messages.length > 0 ? `:\n${messages.map(m => `  - ${m}`).join("\n")}` : ""
}

/** tsc's own output path convention for a given input file under the same rootDir. */
function declarationPathFor(fileName: string): string {
    return fileName.replace(/\.tsx?$/, ".d.ts")
}




function hasExportModifier(node: ts.Node): boolean {
    return ts.canHaveModifiers(node) ? (ts.getModifiers(node)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) ?? false) : false
}

/**
 * Declare the function as it is actually CALLABLE, not as it was written.
 *
 * The capsule wraps every tool export in an async mediation wrapper
 * (capsule/process/scope.ts) — policy is checked before the body runs, and a
 * policy rule may escalate to the user, which is a round trip that cannot be
 * synchronous. So the value the agent holds returns a Promise whatever the
 * author wrote, and a sync-authored tool declared `(): number` is a lie the
 * model acts on: told `add(a, b): number`, it writes `add(1, 2) * 2` and gets
 * NaN with no error raised anywhere.
 *
 * Authors keep writing sync bodies — that works and stays supported. This only
 * changes what the model and the editor are TOLD, so both agree with the
 * runtime. An already-Promise return is left alone (never Promise<Promise<T>>).
 */
function awaitable(declaration: string, node: ts.FunctionDeclaration, src: ts.SourceFile): string {
    const returnType = node.type
    if (!returnType) return declaration

    // A type predicate (`x is string`) or assertion signature (`asserts x`) is
    // only legal in a bare return-type position — `Promise<x is string>` does
    // not parse. Such a tool is unusable across the capsule boundary anyway
    // (the narrowing is erased by serialization), so leave the declaration
    // exactly as the author wrote it rather than emitting broken TypeScript.
    if (ts.isTypePredicateNode(returnType)) return declaration

    const text = returnType.getText(src)
    if (/^Promise\s*</.test(text)) return declaration

    // The return type is the tail of the declaration: everything from the last
    // top-level `:` onwards. Rebasing character offsets from the AST onto
    // `declaration` is not safe — the caller has already stripped a leading
    // `export declare ` and a trailing `;`, so AST positions no longer line up.
    // Matching the type text at the END of the string does line up, because
    // that is exactly where a return type sits.
    const suffix = declaration.lastIndexOf(text)
    if (suffix === -1 || suffix + text.length !== declaration.length) return declaration

    return `${declaration.slice(0, suffix)}Promise<${text}>`
}

function extractJsDoc(node: ts.Node, src: ts.SourceFile): string | undefined {
    const trivia = src.getFullText().slice(node.getFullStart(), node.getStart(src))
    const match = trivia.match(/\/\*\*([\s\S]*?)\*\/\s*$/)
    if (!match) return undefined
    const lines = match[1]!.split("\n").map(l => l.replace(/^\s*\*\s?/, "").trimEnd())
    while (lines.length > 0 && lines[0]!.trim() === "") lines.shift()
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop()
    return lines.length > 0 ? lines.join("\n") : undefined
}

/** Top-level exported function/const declarations from an emitted .d.ts, as ToolFnEntry — the file-level declaration emit reshaped back to the per-function granularity renderScope()/tool-globals.d.ts both need. */
function extractFnEntries(src: ts.SourceFile): ToolFnEntry[] {
    const fns: ToolFnEntry[] = []

    ts.forEachChild(src, node => {
        if (ts.isFunctionDeclaration(node) && hasExportModifier(node) && node.name) {
            const name = node.name.getText(src)
            const jsdoc = extractJsDoc(node, src)
            // tsc emits "export declare function foo(...): T;" — strip the
            // ambient-context keywords the ExecutionScope block already
            // supplies (declare) and the module-level marker (export),
            // leaving a bare `function foo(...): T`.
            const declText = node.getText(src).replace(/^export\s+declare\s+/, "").replace(/;\s*$/, "")
            fns.push({ name, declaration: awaitable(declText, node, src), ...(jsdoc !== undefined ? { jsdoc } : {}) })
        } else if (ts.isVariableStatement(node) && hasExportModifier(node)) {
            for (const decl of node.declarationList.declarations) {
                if (!ts.isIdentifier(decl.name)) continue
                const name = decl.name.getText(src)
                const jsdoc = extractJsDoc(node, src)
                const declText = decl.getText(src)
                fns.push({ name, declaration: `const ${declText}`, ...(jsdoc !== undefined ? { jsdoc } : {}) })
            }
        }
    })

    return fns
}
