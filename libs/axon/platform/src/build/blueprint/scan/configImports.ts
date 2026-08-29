import { dirname, resolve } from "node:path"
import type TsNamespace from "typescript"
import { fsx } from "../../../utils/fs"

/**
 * Static analysis of axon.config.ts — the shared machinery behind resolving
 * a declared thing (a module, a cognet) back to the file that declares it.
 *
 * Both resolvers answer the same question: an author wrote either a registry
 * STRING or an imported BINDING, and the build needs to know which, plus
 * where the source lives if it is the latter. The answer comes from the
 * `import` statement that brought the binding in — the one place the path is
 * written down — resolved against the config's own directory. No runtime
 * stack, no `import.meta`, no dependence on a bundler preserving a filename.
 * Same bytes in, same paths out.
 *
 * This lives apart from its two callers because they had already started to
 * diverge as copies: moduleImports.ts owned all of it, and cognet resolution
 * needed four of the five helpers verbatim. Two near-identical resolvers
 * drifting apart is the same failure that let the h3 globals declare a
 * surface the runtime did not install.
 */

/**
 * `typescript` is ~175ms of module evaluation. Imported eagerly it is paid by
 * everything that touches the blueprint — this module sits behind Config, so
 * "read an agent's config" would mean "load the whole compiler" whether or
 * not there is anything to parse. Bound on first use instead.
 */
let ts!: typeof TsNamespace
let loading: Promise<void> | null = null

export function loadTs(): Promise<void> {
    loading ??= import("typescript").then(mod => { ts = mod.default })
    return loading
}

/** The bound compiler namespace. Only valid after `await loadTs()`. */
export function tsc(): typeof TsNamespace {
    return ts
}

/**
 * How a declared entry resolved.
 *
 * Shared by modules and cognets because the distinction is identical: a
 * relative import is source on disk that the build compiles in place; a bare
 * specifier or a plain string names a package the registry installs.
 */
export type ResolvedDeclaration =
    /** Source on disk: absolute path to its *.config.ts. */
    | { kind: "source"; configPath: string }
    /** A registry artifact declared as a string or bare specifier — no source path. */
    | { kind: "registry"; name: string }
    /** An entry whose import could not be resolved to a file on disk. */
    | { kind: "unresolved"; detail: string }

/** Read and parse a config file. Returns null when it does not exist. */
export async function parseConfig(configFilePath: string): Promise<TsNamespace.SourceFile | null> {
    const content = await fsx.readText(configFilePath)
    if (content === null) return null

    await loadTs()
    return ts.createSourceFile(configFilePath, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

/**
 * A BARE specifier (@scope/pkg/..., pkg/...) names a package in node_modules
 * — already installed and resolved by the package manager. Only a RELATIVE
 * specifier is source living outside node_modules whose path resolves against
 * the config dir.
 */
export function isRelativeSpecifier(specifier: string): boolean {
    return specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/")
}

/**
 * The package name of a bare specifier — "@scope/pkg/module.config" →
 * "@scope/pkg", "pkg/module.config" → "pkg". This is the registry name the
 * artifact is installed and addressed by.
 */
export function packageOf(specifier: string): string {
    const parts = specifier.split("/")
    if (specifier.startsWith("@")) return parts.slice(0, 2).join("/")
    return parts[0]!
}

/** Map every `import Foo from "spec"` default binding to its specifier. */
export function collectDefaultImports(src: TsNamespace.SourceFile): Map<string, string> {
    const imports = new Map<string, string>()
    for (const stmt of src.statements) {
        if (!ts.isImportDeclaration(stmt)) continue
        if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue
        const name = stmt.importClause?.name
        if (name) imports.set(name.text, stmt.moduleSpecifier.text)
    }
    return imports
}

/**
 * Find the value assigned to `key:` inside a defineAgent/defineModule call.
 * Returns the initializer expression, or null when the key is absent.
 */
export function findConfigProperty(
    src: TsNamespace.SourceFile,
    key: string,
): TsNamespace.Expression | null {
    let found: TsNamespace.Expression | null = null

    function visit(node: TsNamespace.Node) {
        if (found) return
        if (
            ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            (node.expression.text === "defineAgent" || node.expression.text === "defineModule") &&
            node.arguments[0] &&
            ts.isObjectLiteralExpression(node.arguments[0])
        ) {
            for (const prop of node.arguments[0].properties) {
                if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === key) {
                    found = prop.initializer
                    return
                }
            }
        }
        ts.forEachChild(node, visit)
    }

    ts.forEachChild(src, visit)
    return found
}

/**
 * Resolve an import specifier to the *.config.ts it names. The specifier
 * usually points at the config's basename without extension
 * (".../module.config"); try the file directly, then common extensions, then
 * the named config inside a directory.
 */
export async function resolveSpecifier(
    specifier: string,
    fromDir: string,
    configNames: readonly string[],
): Promise<string | null> {
    const base = resolve(fromDir, specifier)

    // A specifier that already names a file resolves to itself and nothing
    // else. Appending an extension or a config name to it produces paths like
    // `module.config.ts/module.config.ts` — nonsense the loop below would
    // stat, and whose ENOTDIR the caller has no business handling.
    if (/\.(ts|tsx|js|mjs|cjs)$/.test(specifier)) {
        return fsx.isFile(base) ? base : null
    }

    // Extension-bearing candidates first, then the config inside a directory,
    // and only then the bare path. Order matters: `./brain` names a DIRECTORY
    // whose config is `./brain/cognet.config.ts`, but the bare path exists too
    // — matching it would hand callers a directory where they expect a file,
    // and dirname() of that points at the wrong parent entirely.
    const candidates = [
        `${base}.ts`,
        `${base}.js`,
        ...configNames.map(name => resolve(base, name)),
    ]
    for (const candidate of candidates) {
        if (fsx.isFile(candidate)) return candidate
    }

    // The bare specifier last, and only when it is genuinely a file.
    return fsx.isFile(base) ? base : null
}

/**
 * Resolve one identifier — the shared body of both resolvers.
 *
 * `factory` is the inline-declaration call this entry may legally be written
 * as (`defineModule` / `defineCognet`); written inline, the source IS the
 * config file itself.
 */
export async function resolveBinding(opts: {
    element: TsNamespace.Expression
    imports: Map<string, string>
    configDir: string
    configFilePath: string
    configNames: readonly string[]
    factory: string
    /** What to call this in an error — "module" / "cognet". */
    label: string
}): Promise<ResolvedDeclaration> {
    const { element, imports, configDir, configFilePath, configNames, factory, label } = opts

    // "registry-name"
    if (tsc().isStringLiteral(element)) {
        return { kind: "registry", name: element.text }
    }

    // Ident (imported binding)
    if (tsc().isIdentifier(element)) {
        const specifier = imports.get(element.text)
        if (!specifier) {
            return {
                kind: "unresolved",
                detail: `${label} "${element.text}" is not a default import — a source ${label} must be imported from its ${configNames[0]}`,
            }
        }

        if (!isRelativeSpecifier(specifier)) {
            return { kind: "registry", name: packageOf(specifier) }
        }

        const path = await resolveSpecifier(specifier, configDir, configNames)
        if (!path) {
            return { kind: "unresolved", detail: `cannot resolve ${label} import "${specifier}" from ${configFilePath}` }
        }
        return { kind: "source", configPath: path }
    }

    // defineX({ ... }) written inline — the source IS this config file.
    if (
        tsc().isCallExpression(element) &&
        tsc().isIdentifier(element.expression) &&
        element.expression.text === factory
    ) {
        return { kind: "source", configPath: configFilePath }
    }

    return { kind: "unresolved", detail: `unrecognised ${label} entry — use an imported ${label} or a registry name` }
}

/** The directory a resolved source declaration lives in. */
export function sourceDirOf(resolved: Extract<ResolvedDeclaration, { kind: "source" }>): string {
    return dirname(resolved.configPath)
}
