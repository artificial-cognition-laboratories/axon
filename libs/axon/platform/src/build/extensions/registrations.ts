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

import { join } from "node:path"
import { readFileSync, readdirSync } from "node:fs"
import { fsx } from "../../utils/fs"
import { tsast } from "../../utils/tsast"

/**
 * What a config REGISTERS, read from its source without running it.
 *
 * ── Why static analysis rather than asking the runtime ──────────────────────
 *
 * Types are generated on disk, before a terminal boots — and the whole point
 * is that an editor completes `components.create("me:uptime")` while you are
 * writing the line that uses it. Asking the live TUI what it registered would
 * mean types that only exist once the thing is running, which is exactly
 * backwards.
 *
 * ── Literal arguments only, deliberately ────────────────────────────────────
 *
 * `components.create(name, …)` where `name` is a variable cannot be seen, and
 * that is fine: the name it resolves to is not knowable at generation time
 * either. Every union this feeds keeps a `(string & {})` arm for exactly that
 * case, so a computed name still typechecks — it simply does not complete.
 *
 * A parse, not a program: only the shape of the call site matters, so there is
 * no need for `tsc().createProgram` and its type checker. That keeps this fast
 * enough to run on every config reload rather than only on prepare.
 */

/** One registered name, with whatever documentation sat above the call. */
export type Registration = {
    name: string
    /** JSDoc from immediately above the call site, if any. */
    description?: string
}

/** Everything one source contributes to the ambient surface. */
export type Registrations = {
    components: Registration[]
    lines: Registration[]
    palettes: Registration[]
    /** Command paths, space-joined — `["git", "push"]` reads as "git push". */
    commands: Registration[]
}

export function emptyRegistrations(): Registrations {
    return { components: [], lines: [], palettes: [], commands: [] }
}

/**
 * The call sites worth reading, as `object.method` → which bucket it fills.
 *
 * A table rather than a chain of conditionals: adding a surface is adding a
 * row, and the walker below never grows.
 */
const CALLS: Record<string, keyof Registrations> = {
    "components.create": "components",
    "lines.create": "lines",
    "palette.create": "palettes",
    "commands.register": "commands",
}

/**
 * A call's first argument as a name, or null when it is not a literal.
 *
 * `commands.register` takes a path that may be an array — `["git", "push"]` is
 * one command called "git push", which is how the tree renders it and how
 * `commands.run()` addresses it.
 */
function nameOf(arg: ts.Expression): string | null {
    if (tsc().isStringLiteralLike(arg)) return arg.text

    if (tsc().isArrayLiteralExpression(arg)) {
        const parts: string[] = []
        for (const element of arg.elements) {
            if (!tsc().isStringLiteralLike(element)) return null
            parts.push(element.text)
        }
        return parts.length > 0 ? parts.join(" ") : null
    }

    return null
}

/** Read one file's registrations. Unreadable or unparseable files contribute nothing. */
export function readRegistrations(filePath: string): Registrations {
    const out = emptyRegistrations()

    let source: string
    try {
        source = readFileSync(filePath, "utf-8")
    } catch {
        // A file that cannot be read is a file that registers nothing. The
        // loader reports its own failures; this is not the place to duplicate
        // that, and throwing here would cost every OTHER source its types.
        return out
    }

    const file = tsast.parse(filePath, source)

    const visit = (node: ts.Node): void => {
        if (tsc().isCallExpression(node) && tsc().isPropertyAccessExpression(node.expression)) {
            const target = `${node.expression.expression.getText(file)}.${node.expression.name.getText(file)}`
            const bucket = CALLS[target]
            const first = node.arguments[0]

            if (bucket && first) {
                const name = nameOf(first)
                if (name !== null) {
                    // The JSDoc is read from the STATEMENT, not the call: a
                    // comment sits above `components.create(...)` as a whole,
                    // and asking the call node returns nothing.
                    const statement = findStatement(node)
                    // Trimmed: tsast.jsdoc preserves the leading space after
                    // the `*`, which would land inside the generated `/** */`
                    // and read as an indent nobody wrote.
                    const description = statement ? tsast.jsdoc(statement, file)?.trim() : undefined
                    out[bucket].push({ name, ...(description ? { description } : {}) })
                }
            }
        }
        tsc().forEachChild(node, visit)
    }

    visit(file)
    return out
}

/** Walk up to the statement a call belongs to — where its JSDoc lives. */
function findStatement(node: ts.Node): ts.Node | undefined {
    let current: ts.Node | undefined = node
    while (current && !tsc().isSourceFile(current.parent)) current = current.parent
    return current
}

/**
 * Every registration under one source root — `main.ts` plus `plugins/*.ts`.
 *
 * The same files the loader imports, and in the same order, so what an editor
 * completes matches what actually registers. A source with neither is not an
 * error: an extension may be all config and no code.
 */
export function scanSource(root: string): Registrations {
    const out = emptyRegistrations()

    const files: string[] = []
    const main = join(root, "main.ts")
    if (fsx.exists(main)) files.push(main)

    // Sync, because typegen is: the generator writes files inline and an async
    // hop here would make every caller await for one directory read.
    const pluginsDir = join(root, "plugins")
    if (fsx.exists(pluginsDir)) {
        for (const entry of readdirSync(pluginsDir).sort()) {
            if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) files.push(join(pluginsDir, entry))
        }
    }

    for (const file of files) {
        const found = readRegistrations(file)
        out.components.push(...found.components)
        out.lines.push(...found.lines)
        out.palettes.push(...found.palettes)
        out.commands.push(...found.commands)
    }

    return out
}

/** Merge several sources' registrations into one, first-registered wins on a duplicate name. */
export function mergeRegistrations(all: readonly Registrations[]): Registrations {
    const out = emptyRegistrations()

    for (const key of ["components", "lines", "palettes", "commands"] as const) {
        const seen = new Set<string>()
        for (const source of all) {
            for (const entry of source[key]) {
                // First wins, matching the loader: a user's own config loads
                // before extensions, and between extensions the earlier one in
                // profile.config.ts keeps the name.
                if (seen.has(entry.name)) continue
                seen.add(entry.name)
                out[key].push(entry)
            }
        }
    }

    return out
}
