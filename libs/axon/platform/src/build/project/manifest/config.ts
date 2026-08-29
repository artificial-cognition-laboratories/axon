import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { err } from "@arcforge/err"
import { text } from "./text"

/**
 * The declaration arrays this leaf edits. Both hold registry names and behave
 * identically — a module brings capabilities, a prompt brings work — so one set
 * of surgical edits serves both.
 */
export type ConfigArray = "modules" | "prompts"

type ConfigOpts = {
    root: string
}

/**
 * axon.config.ts — surgical edits to the agent's `modules: [...]` array.
 *
 * The config is the activation record: what the agent actually has. `install`
 * adds an entry here the same way `npm install --save` adds to package.json,
 * and for the same reason — the user should not have to hand-edit a manifest to
 * finish an install they already asked for.
 *
 * Registry modules are referenced by STRING ("@axon/obsidian"), not by import,
 * so this only ever inserts into or removes from one array literal. Source
 * modules are imports and are never touched here — their declaration is the
 * import statement itself, which belongs to the author.
 */
export function Config(opts: ConfigOpts) {
    const path = join(opts.root, "axon.config.ts")

    /** Whether the config already references this module name as a string entry. */
    function declares(source: string, name: string): boolean {
        return new RegExp(`["']${text.escape(name)}["']`).test(source)
    }

    return {
        path,
        declares,

        /** Add a registry module to `modules: [...]`, if not already declared. */
        async add(name: string, key: ConfigArray = "modules"): Promise<boolean> {
            const source = await readFile(path, "utf-8")
            if (declares(source, name)) return false

            const array = locate(source, key)
            if (!array) {
                // A scaffolded agent has no modules key until its first install.
                // Creating it is part of installing, not something to make the
                // user do by hand.
                if (await insertKey(path, source, name, key)) return true

                throw err("CONFIG_MODULES_UNPARSEABLE", {
                    detail: `could not find a "${key}: [...]" array in axon.config.ts — add "${name}" to it by hand`,
                    context: { name },
                })
            }

            const body = source.slice(array.start, array.end)
            const entry = `"${name}"`

            // Always emit the multi-line form: an entry per line keeps
            // subsequent adds and removes to a single whole line, which is what
            // makes the line-oriented edits exact rather than a guess.
            const existing = body.trim().replace(/,$/, "")
            const lines = existing === ""
                ? [entry]
                : [...existing.split("\n").map(line => line.trim()).filter(Boolean), entry]

            const updated = `\n${lines.map(line => `${array.indent}${line.replace(/,$/, "")},`).join("\n")}\n${array.closingIndent}`

            await writeFile(path, source.slice(0, array.start) + updated + source.slice(array.end))
            return true
        },

        /** Remove a registry module entry. Returns false when it was not declared. */
        async remove(name: string): Promise<boolean> {
            const source = await readFile(path, "utf-8")
            if (!declares(source, name)) return false

            // Drop the whole line, plus its trailing comma and newline.
            const updated = source.replace(
                new RegExp(`^[ \\t]*["']${text.escape(name)}["'][ \\t]*,?[ \\t]*\\r?\\n`, "m"),
                "",
            )
            if (updated === source) {
                throw err("CONFIG_MODULES_UNPARSEABLE", {
                    detail: `"${name}" is declared in axon.config.ts but not on a line of its own — remove it by hand`,
                    context: { name },
                })
            }

            await writeFile(path, updated)
            return true
        },

        /**
         * Every registry module the config activates, by package name.
         *
         * Read textually, from the same `modules: [...]` span the add/remove
         * edits target — this answers "what did the author declare", which is a
         * property of the file, not of an evaluated blueprint. Callers that need
         * the resolved module surface load a Blueprint instead.
         */
        async declared(key: ConfigArray = "modules"): Promise<Set<string>> {
            const source = await readFile(path, "utf-8").catch(() => "")
            const array = locate(source, key)
            if (!array) return new Set()

            const body = source.slice(array.start, array.end)
            return new Set([...body.matchAll(/["'](@[^"']+)["']/g)].map(match => match[1]!))
        },

        /**
         * Whether the config declares this module BY REGISTRY NAME — the
         * string form the add/remove edits act on.
         *
         * False for a SOURCE module, whose declaration is an import binding
         * (`import Mod from "../telegram/module.config"` plus `Mod` in the
         * array) rather than a name. That is not "not installed": the agent
         * loads it and it appears in the blueprint. It means this leaf cannot
         * edit the declaration, because the import statement is the author's
         * own code.
         *
         * Exists so uninstall can REFUSE before touching anything, rather
         * than removing the dependency and discovering afterwards that the
         * declaration is one it does not know how to remove.
         */
        async declaresName(name: string): Promise<boolean> {
            const source = await readFile(path, "utf-8").catch(() => "")
            return declares(source, name)
        },

        /**
         * The cognet this agent declares — `cognet: "@axon/zero"` — or null
         * when the key is absent.
         *
         * A SCALAR, which is why it cannot go through `declared()`: there is
         * exactly one brain, so the declaration is a single string rather than
         * an array. Null means the author never wrote the key and the agent
         * runs the default; the caller decides what that default is, because
         * this leaf reads the file and nothing more.
         *
         * Read textually for the same reason `declared()` is: this answers
         * what the AUTHOR wrote, which is a property of the file. A caller
         * that needs the resolved brain loads a Blueprint.
         */
        async cognet(): Promise<string | null> {
            const source = await readFile(path, "utf-8").catch(() => "")
            // Anchored to a line start so a `cognet:` inside a comment or a
            // nested object cannot be mistaken for the declaration.
            const match = /(^|\n)[ \t]*cognet\s*:\s*["']([^"']+)["']/.exec(source)
            return match?.[2] ?? null
        },
    }
}

export type ConfigT = ReturnType<typeof Config>

/**
 * Locate the interior of the `modules: [...]` array — the span between its
 * brackets — tracking nesting so a nested array (options tuples like
 * ["@axon/x", { ... }]) cannot terminate the scan early.
 */
function locate(
    source: string,
    key: ConfigArray,
): { start: number; end: number; indent: string; closingIndent: string } | null {
    const match = new RegExp(`(^|\\n)([ \\t]*)${key}\\s*:\\s*\\[`).exec(source)
    if (!match) return null

    const open = match.index + match[0].length - 1
    const declarationIndent = match[2] ?? ""

    let depth = 0
    for (let i = open; i < source.length; i++) {
        const char = source[i]
        if (char === "[") depth++
        else if (char === "]") {
            depth--
            if (depth === 0) {
                return {
                    start: open + 1,
                    end: i,
                    indent: `${declarationIndent}    `,
                    closingIndent: declarationIndent,
                }
            }
        }
    }

    return null
}

/**
 * Add a `modules: [...]` key to a config that has none, immediately after
 * `defineAgent({`. Returns false when even that anchor is missing, leaving the
 * caller to fail loudly rather than write somewhere it guessed.
 *
 * Two shapes, because a config is written by a human OR by the scaffolder:
 *
 *   defineAgent({          an object already spanning lines — insert a key
 *       description: "…",  at the top, matching the indentation in use
 *   })
 *
 *   defineAgent({})        the scaffolded config, empty and on ONE line —
 *                          it has to be opened up before a key fits
 *
 * The second shape used to fall through to the error, which meant the FIRST
 * `axon install` into every freshly scaffolded agent failed to record what it
 * had just installed: the package landed on disk, the config never listed it,
 * and the agent did not load it. Silent half-success, on the most common path
 * there is. `tests/…/installer/config.test.ts` covered only multi-line
 * fixtures, which is why it survived.
 */
async function insertKey(path: string, source: string, name: string, key: ConfigArray): Promise<boolean> {
    const entry = (indent: string) => `${indent}${key}: [\n${indent}${indent}"${name}",\n${indent}],`

    // An object that is already open across lines: insert after the newline.
    const open = /defineAgent\s*\(\s*\{[ \t]*\r?\n/.exec(source)
    if (open) {
        const at = open.index + open[0].length
        // Match the indentation of whatever key already follows the brace.
        const indent = /^([ \t]+)\S/m.exec(source.slice(at))?.[1] ?? "    "
        await writeFile(path, source.slice(0, at) + entry(indent) + "\n" + source.slice(at))
        return true
    }

    // An EMPTY object on one line. Anything else inline (`defineAgent({ a: 1 })`)
    // is left alone deliberately: rewriting a populated one-liner means
    // reformatting code the author wrote, and this function's contract is to
    // insert a key or decline — never to reflow.
    const empty = /defineAgent\s*\(\s*\{[ \t]*\}/.exec(source)
    if (empty) {
        const indent = "    "
        const replacement = `defineAgent({\n${entry(indent)}\n}`
        await writeFile(
            path,
            source.slice(0, empty.index) + replacement + source.slice(empty.index + empty[0].length),
        )
        return true
    }

    return false
}
