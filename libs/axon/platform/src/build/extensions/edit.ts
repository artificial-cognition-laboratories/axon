import ts from "typescript"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { err } from "@arcforge/err"
import { fsx } from "../../utils/fs"
import { tsast } from "../../utils/tsast"
import { parseRef } from "./store"

/**
 * Surgical edits to `profile.config.ts` — adding and removing entries in its
 * `extensions` array.
 *
 * ── Why an AST edit rather than a rewrite ───────────────────────────────────
 *
 * This is the user's own file. It may carry comments, an entry disabled with
 * `enabled: false`, an ordering they chose deliberately (load order IS the
 * collision policy), and whatever else they wrote around it. Regenerating it
 * from a parsed model would silently discard all of that, so the array's
 * contents are located in the source and the surrounding text is left byte-for-
 * byte identical.
 *
 * The same reasoning as `manifest/engine.ts`, which edits `axon.config.ts` in
 * place rather than re-emitting it — and the property that made a declarative
 * `extensions:` array the right choice over Vim-style imperative registration:
 * a list a machine can edit.
 *
 * ── Failing loudly is the point ─────────────────────────────────────────────
 *
 * A config this cannot parse is NOT edited. There is no fallback that appends
 * text hopefully, because a botched write damages a file the user wrote by
 * hand — the error names the file and asks them to add the line themselves,
 * which is a worse experience than it working and a far better one than a
 * corrupted config.
 */

/** Where the `extensions: [...]` array lives in a profile config's source. */
type Located = {
    array: ts.ArrayLiteralExpression
    source: ts.SourceFile
    text: string
}

const CONFIG = "profile.config.ts"

function configPath(profileRoot: string): string {
    return join(profileRoot, CONFIG)
}

/**
 * Find `defineProfile({ extensions: [...] })`.
 *
 * Located by shape rather than by position: the call may be assigned, exported
 * directly, or wrapped, and only the argument object matters.
 */
function locate(path: string, text: string, field = "extensions"): Located | null {
    const source = tsast.parse(path, text)
    let found: ts.ArrayLiteralExpression | null = null

    const visit = (node: ts.Node): void => {
        if (found) return
        if (
            ts.isCallExpression(node)
            && ts.isIdentifier(node.expression)
            && node.expression.text === "defineProfile"
            && node.arguments.length > 0
        ) {
            const arg = node.arguments[0]
            if (arg && ts.isObjectLiteralExpression(arg)) {
                const value = tsast.prop(arg, field)
                if (value && ts.isArrayLiteralExpression(value)) {
                    found = value
                    return
                }
            }
        }
        ts.forEachChild(node, visit)
    }
    visit(source)

    return found ? { array: found, source, text } : null
}

/**
 * The `defineProfile({ ... })` object itself, for a field that may be absent.
 *
 * `locate()` answers "where is this array" and returns null when the field is
 * not declared at all — which is the right answer for reading, and the wrong
 * one for a write that should CREATE the field. Connecting a provider on a
 * profile that has never named one has to work.
 */
function locateObject(path: string, text: string): { object: ts.ObjectLiteralExpression; source: ts.SourceFile } | null {
    const source = tsast.parse(path, text)
    let found: ts.ObjectLiteralExpression | null = null

    tsast.visitCalls(source, "defineProfile", call => {
        if (found) return
        const arg = call.arguments[0]
        if (arg && ts.isObjectLiteralExpression(arg)) found = arg
    })

    return found ? { object: found, source } : null
}

/** The `source` string of one entry — a bare string, or the `source:` of an object form. */
function sourceOf(element: ts.Expression): string | null {
    if (ts.isStringLiteralLike(element)) return element.text
    if (ts.isObjectLiteralExpression(element)) {
        const value = tsast.prop(element, "source")
        return value && ts.isStringLiteralLike(value) ? value.text : null
    }
    return null
}

/** Read the enabled extension sources a config declares, in order. */
export async function readEntries(profileRoot: string): Promise<string[]> {
    const path = configPath(profileRoot)
    if (!fsx.exists(path)) return []

    const located = locate(path, await readFile(path, "utf-8"))
    if (!located) return []

    return located.array.elements
        .map(sourceOf)
        .filter((s): s is string => s !== null)
}

export type EditResult = {
    /** False when the entry was already in the state asked for — nothing was written. */
    changed: boolean
}

/**
 * Add an entry to `extensions`, if it is not already there.
 *
 * Appended rather than inserted: the array is load order, and load order
 * decides collisions, so a new extension goes last — where it loses to
 * everything already installed rather than silently displacing it.
 */
export async function addEntry(profileRoot: string, source: string): Promise<EditResult> {
    const path = configPath(profileRoot)
    if (!fsx.exists(path)) {
        throw err("PROFILE_CONFIG_MISSING", { detail: path, context: { path } })
    }

    const text = await readFile(path, "utf-8")
    const located = locate(path, text)
    if (!located) {
        throw err("PROFILE_CONFIG_UNEDITABLE", {
            detail: `could not find an "extensions: [ ... ]" array in ${path}`,
            context: { path, source },
        })
    }

    const existing = located.array.elements.map(sourceOf)
    if (existing.includes(source)) return { changed: false }

    // Same extension at a DIFFERENT version replaces it, rather than joining
    // it in the list.
    //
    // Installs pin the resolved version, so re-installing after a publish
    // produces a new ref ("@cody/theme@0.1.2" where the config holds
    // "@cody/theme@0.1.1"). A plain string dedupe sees two different entries
    // and keeps both — which loads the extension twice, and every collision
    // between the two copies resolves against whichever came first. One
    // extension, one entry.
    const { name } = parseRef(source)
    const conflicting = existing.find(entry => entry !== null && parseRef(entry).name === name)
    if (conflicting !== undefined && conflicting !== null) {
        await removeEntry(profileRoot, conflicting)
        // Re-read: the removal moved every offset this function had computed.
        return addEntry(profileRoot, source)
    }

    const entry = `"${source}"`
    const elements = located.array.elements

    // Indentation is copied from whatever is already there, so an edit is
    // invisible in a diff beside the user's own formatting. A first entry has
    // nothing to copy, so it takes the array's own line plus one level.
    const last = elements[elements.length - 1]
    const arrayStart = located.array.getStart(located.source)

    let next: string
    if (last) {
        // Insert AFTER the previous element's trailing comma when it has one.
        // Inserting before it produced `"a"\n  "b",,` — caught by verified()
        // rather than written, which is what that check is for.
        const trailing = text.slice(last.getEnd()).match(/^\s*,/)
        const insertAt = last.getEnd() + (trailing ? trailing[0].length : 0)
        const indent = " ".repeat(indentOf(text, last.getStart(located.source)))

        next = text.slice(0, insertAt) + `${trailing ? "" : ","}\n${indent}${entry},` + text.slice(insertAt)
    } else {
        // An empty array: open a line inside it, and close on the array's own
        // indentation so the `]` lands where the user would have put it.
        const indent = " ".repeat(indentOf(text, arrayStart) + 4)
        const closing = " ".repeat(indentOf(text, arrayStart))
        next = text.slice(0, arrayStart + 1) + `\n${indent}${entry},\n${closing}` + text.slice(arrayStart + 1)
    }

    await writeFile(path, verified(next, path))

    return { changed: true }
}

/**
 * Remove an entry from `extensions`, if it is there.
 *
 * The whole element goes, including an object form carrying `enabled: false` —
 * uninstalling is not the same as disabling, and leaving a disabled husk behind
 * would make `axon ext list` show something that is not installed.
 */
export async function removeEntry(profileRoot: string, source: string): Promise<EditResult> {
    const path = configPath(profileRoot)
    if (!fsx.exists(path)) return { changed: false }

    const text = await readFile(path, "utf-8")
    const located = locate(path, text)
    if (!located) {
        throw err("PROFILE_CONFIG_UNEDITABLE", {
            detail: `could not find an "extensions: [ ... ]" array in ${path}`,
            context: { path, source },
        })
    }

    const target = located.array.elements.find(element => sourceOf(element) === source)
    if (!target) return { changed: false }

    // Take the element, its trailing comma, and the whitespace BEFORE it —
    // getFullStart() includes that leading trivia, which is the newline and
    // indent the element sits on.
    const start = target.getFullStart()
    const after = text.slice(target.getEnd())
    const comma = after.match(/^[^\S\n]*,/)
    let end = target.getEnd() + (comma ? comma[0].length : 0)

    // Removing the LAST element leaves the array's own closing line preceded by
    // the indent that used to belong to an entry — `[\n    ]` rather than `[]`.
    // Each removal adds one such line, so a user who installs and uninstalls a
    // few times ends up with a stack of blank lines inside the brackets. It
    // parses, which is why the parse-before-write check never caught it, and it
    // is still wrong in a file whose whole purpose is being opened and edited.
    //
    // Only when the array is now EMPTY: with entries left, the whitespace
    // between them is the formatting the user (or addEntry) chose, and
    // rewriting it would reformat lines nobody touched.
    let next = text.slice(0, start) + text.slice(end)
    if (located.array.elements.length === 1) {
        next = next.replace(/\[\s*\]/, "[]")
    }
    await writeFile(path, verified(next, path))

    return { changed: true }
}

/** Columns of indentation on the line containing `offset`. */
function indentOf(text: string, offset: number): number {
    const lineStart = text.lastIndexOf("\n", offset - 1) + 1
    const line = text.slice(lineStart, offset)
    const match = line.match(/^\s*/)
    return match ? match[0].length : 0
}

/**
 * Parse the result before it is written.
 *
 * A write that produced a syntactically broken config would take the user's
 * whole TUI config down — every command, key and palette — for an install. The
 * edits above are careful, but "careful" is not a guarantee and this is: a
 * result that does not parse is never written.
 */
function verified(next: string, path: string): string {
    const parsed = ts.createSourceFile(path, next, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    // `parseDiagnostics` is not on the public type but is populated by the
    // parser; an empty list is the only acceptable outcome here.
    const diagnostics = (parsed as unknown as { parseDiagnostics?: readonly unknown[] }).parseDiagnostics ?? []
    if (diagnostics.length > 0) {
        throw err("PROFILE_CONFIG_UNEDITABLE", {
            detail: `editing ${path} would have produced invalid TypeScript — the file was left unchanged`,
            context: { path },
        })
    }
    return next
}


// ── Settings ─────────────────────────────────────────────────────────────────

/**
 * Find the object literal `defineProfile()` was called with.
 *
 * Separate from `locate()` above, which narrows straight to the `extensions`
 * array. Settings live on a sibling key that may not exist yet, so this needs
 * the whole argument to write into.
 */
function locateConfig(path: string, text: string): { object: ts.ObjectLiteralExpression; source: ts.SourceFile } | null {
    const source = tsast.parse(path, text)
    let found: ts.ObjectLiteralExpression | null = null

    const visit = (node: ts.Node): void => {
        if (found) return
        if (
            ts.isCallExpression(node)
            && ts.isIdentifier(node.expression)
            && node.expression.text === "defineProfile"
            && node.arguments.length > 0
        ) {
            const arg = node.arguments[0]
            if (arg && ts.isObjectLiteralExpression(arg)) {
                found = arg
                return
            }
        }
        ts.forEachChild(node, visit)
    }
    visit(source)

    return found ? { object: found, source } : null
}

/** Read the `settings` object a config declares, as plain data. */
export async function readSettings(profileRoot: string): Promise<Record<string, unknown>> {
    const path = configPath(profileRoot)
    if (!fsx.exists(path)) return {}

    const text = await readFile(path, "utf-8")
    const located = locateConfig(path, text)
    if (!located) return {}

    const value = tsast.prop(located.object, "settings")
    if (!value || !ts.isObjectLiteralExpression(value)) return {}
    return literalOf(value) as Record<string, unknown>
}

/**
 * The machine-wide policy ceiling a profile declares.
 *
 * A TOP-LEVEL key, sibling to `settings` rather than inside it. `ProfileSettings`
 * is deliberately "the keys the terminal itself acts on"; policy is read by the
 * RUNTIME and enforced in the capsule, so folding it in would widen that set's
 * meaning to "anything configurable" and lose the boundary it draws.
 *
 * Read by AST, exactly like `readSettings` — no import, no evaluation, no
 * lock. That matters more here than there: the blueprint path resolves this on
 * every agent load, including `axon run` in a script, and it must not depend on
 * the extensions loader (which imports and evaluates the user's TypeScript
 * behind a serialized lock). A ceiling that only applied when the TUI happened
 * to have loaded a config would be advisory, and advisory is not a ceiling.
 *
 * Returns `{}` for a profile with no policy, which the resolver reads as "no
 * opinion" — every capability falls through to the agent's own policy.
 */
export async function readPolicy(profileRoot: string): Promise<Record<string, unknown>> {
    const path = configPath(profileRoot)
    if (!fsx.exists(path)) return {}

    const text = await readFile(path, "utf-8")
    const located = locateConfig(path, text)
    if (!located) return {}

    const value = tsast.prop(located.object, "policy")
    if (!value || !ts.isObjectLiteralExpression(value)) return {}
    return literalOf(value) as Record<string, unknown>
}

/**
 * Set one key on `settings`, creating the block if it is absent.
 *
 * ── Why the config and not a sidecar ────────────────────────────────────────
 *
 * `profile.config.ts` is the source of truth for a terminal, so what is in
 * effect is what you can read. A second store holding runtime changes would
 * make "why isn't my config taking effect" a real question, and answering it
 * would mean explaining a precedence rule nobody asked for.
 *
 * ── Whole-value replacement ────────────────────────────────────────────────
 *
 * A key is replaced entirely rather than deep-merged. `verbosity` is one
 * setting whose value happens to be an object; merging into it would make
 * "clear this back to default" impossible to express, since every write would
 * only ever add.
 *
 * Formatting is copied from whatever is already there, so an edit is invisible
 * in a diff beside the user's own layout — same as `addEntry`.
 */
/**
 * A settings key as it must appear in source.
 *
 * Quoted unless it is a plain identifier. Settings names follow CSS where CSS
 * has a name for the thing (`padding-inline`, `padding-block`), and a hyphen is
 * not valid in a bare property name — emitting one produced source that
 * `verified()` correctly refused to write, so the setting could never be
 * stored. Reading already handled quoted keys (see `nameOf`); only writing did
 * not.
 */
function keyToken(key: string): string {
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key)
}

export async function setSetting(profileRoot: string, key: string, value: unknown): Promise<EditResult> {
    const path = configPath(profileRoot)
    if (!fsx.exists(path)) {
        throw err("PROFILE_CONFIG_MISSING", { detail: path, context: { path } })
    }

    const text = await readFile(path, "utf-8")
    const located = locateConfig(path, text)
    if (!located) {
        throw err("PROFILE_CONFIG_UNEDITABLE", {
            detail: `could not find a defineProfile({ ... }) call in ${path}`,
            context: { path, key },
        })
    }

    const settings = tsast.prop(located.object, "settings")
    const rendered = render(value, indentOf(text, located.object.getStart(located.source)) + 8)

    // Already exactly this — nothing to write, and nothing to reload.
    const current = await readSettings(profileRoot)
    if (JSON.stringify(current[key]) === JSON.stringify(value)) return { changed: false }

    if (settings && ts.isObjectLiteralExpression(settings)) {
        const existing = settings.properties.find(
            prop => ts.isPropertyAssignment(prop) && nameOf(prop.name) === key,
        )
        const inner = indentOf(text, settings.getStart(located.source)) + 4

        if (existing && ts.isPropertyAssignment(existing)) {
            // Replace just the value, so the key keeps its place in the block.
            const next = text.slice(0, existing.initializer.getStart(located.source))
                + render(value, inner)
                + text.slice(existing.initializer.getEnd())
            await writeFile(path, verified(next, path))
            return { changed: true }
        }

        // Appended after the last property, not prepended at the brace.
        //
        // Inserting at the open brace put every new key at the TOP, so a config
        // read back in reverse order of when its settings were set — which is
        // not how anyone writes a settings block, and made a machine edit
        // obvious in a diff for no reason.
        const closing = " ".repeat(indentOf(text, settings.getStart(located.source)))
        const props = settings.properties
        const lastProp = props[props.length - 1]

        let next: string
        if (lastProp) {
            const trailing = text.slice(lastProp.getEnd()).match(/^[^\S\n]*,/)
            const insertAt = lastProp.getEnd() + (trailing ? trailing[0].length : 0)
            next = text.slice(0, insertAt)
                + `${trailing ? "" : ","}\n${" ".repeat(inner)}${keyToken(key)}: ${render(value, inner)},`
                + text.slice(insertAt)
        } else {
            const open = settings.getStart(located.source) + 1
            next = text.slice(0, open)
                + `\n${" ".repeat(inner)}${keyToken(key)}: ${render(value, inner)},\n${closing}`
                + text.slice(open)
        }
        await writeFile(path, verified(next, path))
        return { changed: true }
    }

    // No settings block at all — add one after the last existing property, so
    // it lands beside `extensions` rather than at the top of a file the user
    // has already arranged.
    const props = located.object.properties
    const last = props[props.length - 1]
    const indent = " ".repeat(last ? indentOf(text, last.getStart(located.source)) : 4)
    const block = `\n\n${indent}settings: {\n${indent}    ${keyToken(key)}: ${rendered},\n${indent}},`

    if (last) {
        const trailing = text.slice(last.getEnd()).match(/^\s*,/)
        const insertAt = last.getEnd() + (trailing ? trailing[0].length : 0)
        const next = text.slice(0, insertAt) + `${trailing ? "" : ","}` + block + text.slice(insertAt)
        await writeFile(path, verified(next, path))
        return { changed: true }
    }

    const open = located.object.getStart(located.source) + 1
    const next = text.slice(0, open) + block + `\n` + text.slice(open)
    await writeFile(path, verified(next, path))
    return { changed: true }
}

/** A property key as written — identifier or string literal. */
function nameOf(name: ts.PropertyName): string | null {
    if (ts.isIdentifier(name)) return name.text
    if (ts.isStringLiteralLike(name)) return name.text
    return null
}

/**
 * A literal AST node as plain data. Returns undefined for anything computed —
 * a settings file may contain expressions, and guessing at their value would
 * be worse than reporting the key as unset.
 */
function literalOf(node: ts.Expression): unknown {
    if (ts.isStringLiteralLike(node)) return node.text
    if (ts.isNumericLiteral(node)) return Number(node.text)
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false
    if (ts.isArrayLiteralExpression(node)) return node.elements.map(literalOf)
    if (ts.isObjectLiteralExpression(node)) {
        const out: Record<string, unknown> = {}
        for (const prop of node.properties) {
            if (!ts.isPropertyAssignment(prop)) continue
            const key = nameOf(prop.name)
            if (key !== null) out[key] = literalOf(prop.initializer)
        }
        return out
    }
    return undefined
}

/**
 * A value as TypeScript source, matching the file's own formatting.
 *
 * Arrays and objects go multi-line at the given indent, because that is how a
 * person writes a settings block and a machine edit should be indistinguishable
 * from a hand edit.
 */
function render(value: unknown, indent: number): string {
    const pad = " ".repeat(indent)
    const inner = " ".repeat(indent + 4)

    if (typeof value === "string") return JSON.stringify(value)
    if (typeof value === "number" || typeof value === "boolean") return String(value)
    if (value === null || value === undefined) return "undefined"

    if (Array.isArray(value)) {
        if (value.length === 0) return "[]"
        const items = value.map(item => `${inner}${render(item, indent + 4)},`).join("\n")
        return `[\n${items}\n${pad}]`
    }

    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) return "{}"
    const body = entries
        .map(([key, item]) => `${inner}${/^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key)}: ${render(item, indent + 4)},`)
        .join("\n")
    return `{\n${body}\n${pad}}`
}

// ── providers ────────────────────────────────────────────────────────────────

/**
 * Which provider factory a `providers:` element calls.
 *
 * Elements here are CALL EXPRESSIONS (`Axon()`, `Ollama({ url })`), not the
 * strings `extensions:` holds — so identity is the callee's name. An element
 * that is not a recognisable call answers null and is left strictly alone: a
 * user may have written something this editor does not understand, and
 * touching it would be worse than ignoring it.
 */
function factoryOf(element: ts.Expression): string | null {
    if (!ts.isCallExpression(element)) return null
    return ts.isIdentifier(element.expression) ? element.expression.text : null
}

/** Whether a `providers:` element was written with options — `Ollama({ url })` rather than `Ollama()`. */
function hasOptions(element: ts.Expression): boolean {
    return ts.isCallExpression(element) && element.arguments.length > 0
}

/** The provider factories a profile declares, in order. */
export async function readProviders(profileRoot: string): Promise<string[]> {
    const path = configPath(profileRoot)
    if (!fsx.exists(path)) return []

    const located = locate(path, await readFile(path, "utf-8"), "providers")
    if (!located) return []

    return located.array.elements
        .map(factoryOf)
        .filter((name): name is string => name !== null)
}

/**
 * Declare a provider, if it is not already declared.
 *
 * Called AFTER the vault connection succeeds, never before: a profile that
 * advertised a provider whose credential never landed would fail its
 * catalogue on every boot, for something the user never finished setting up.
 *
 * Creates the `providers:` field when the profile has none, so connecting on a
 * profile that never named a provider works rather than throwing about a
 * missing array.
 */
export async function addProvider(profileRoot: string, factory: string): Promise<EditResult> {
    const path = configPath(profileRoot)
    if (!fsx.exists(path)) {
        throw err("PROFILE_CONFIG_MISSING", { detail: path, context: { path } })
    }

    const text = await readFile(path, "utf-8")
    const located = locate(path, text, "providers")

    if (located) {
        if (located.array.elements.map(factoryOf).includes(factory)) return { changed: false }

        const entry = `${factory}()`
        const elements = located.array.elements
        const last = elements[elements.length - 1]
        const arrayStart = located.array.getStart(located.source)

        // Same splice discipline as addEntry: copy the author's indentation,
        // insert after a trailing comma rather than before it.
        let next: string
        if (last) {
            const trailing = text.slice(last.getEnd()).match(/^\s*,/)
            const insertAt = last.getEnd() + (trailing ? trailing[0].length : 0)
            const indent = " ".repeat(indentOf(text, last.getStart(located.source)))
            next = text.slice(0, insertAt) + `${trailing ? "" : ","}\n${indent}${entry},` + text.slice(insertAt)
        } else {
            const indent = " ".repeat(indentOf(text, arrayStart) + 4)
            const closing = " ".repeat(indentOf(text, arrayStart))
            next = text.slice(0, arrayStart + 1) + `\n${indent}${entry},\n${closing}` + text.slice(arrayStart + 1)
        }

        await writeFile(path, verified(next, path))
        return { changed: true }
    }

    // No `providers:` yet — add the whole field.
    const object = locateObject(path, text)
    if (!object) {
        throw err("PROFILE_CONFIG_UNEDITABLE", {
            detail: `could not find a defineProfile({ ... }) call in ${path}`,
            context: { path, factory },
        })
    }

    const first = object.object.properties[0]
    const insertAt = first ? first.getStart(object.source) : object.object.getStart(object.source) + 1
    const indent = first ? " ".repeat(indentOf(text, insertAt)) : "    "
    const field = `providers: [${factory}()],`
    const next = first
        ? text.slice(0, insertAt) + `${field}\n\n${indent}` + text.slice(insertAt)
        : text.slice(0, insertAt) + `\n${indent}${field}\n` + text.slice(insertAt)

    await writeFile(path, verified(next, path))
    return { changed: true }
}

/**
 * Undeclare a provider, if it is declared with no options.
 *
 * An entry WITH options (`Ollama({ url: "http://box.local:11434" })`) is left
 * in place: the user configured it deliberately, and silently deleting a
 * self-hosted endpoint on a disconnect is destroying something they cannot
 * recover from this command. A bare `Ollama()` carries no such information and
 * is safe to remove.
 *
 * Removing matters because `providers:` means "sources I have". A disconnected
 * provider left declared contributes a failing catalogue on every boot — a
 * visible error for something the user deliberately turned off.
 */
export async function removeProvider(profileRoot: string, factory: string): Promise<EditResult> {
    const path = configPath(profileRoot)
    if (!fsx.exists(path)) return { changed: false }

    const text = await readFile(path, "utf-8")
    const located = locate(path, text, "providers")
    if (!located) return { changed: false }

    const element = located.array.elements.find(entry => factoryOf(entry) === factory)
    if (!element) return { changed: false }
    if (hasOptions(element)) return { changed: false }

    const start = element.getStart(located.source)
    const end = element.getEnd()

    // Take the trailing comma and the whitespace before the element, so the
    // removal leaves no blank line and no dangling `,` — the same shape
    // removeEntry produces.
    const after = text.slice(end).match(/^\s*,/)
    const cutEnd = end + (after ? after[0].length : 0)
    const before = text.slice(0, start).match(/\s*$/)
    const cutStart = start - (before ? before[0].length : 0)

    await writeFile(path, verified(text.slice(0, cutStart) + text.slice(cutEnd), path))
    return { changed: true }
}
