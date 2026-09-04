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

import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { err } from "@arcforge/err"
import { tsast } from "../../../utils/tsast"

/**
 * axon.config.ts — the agent's `model:` field.
 *
 * Which model drives the cortex is the one inference decision a user makes by
 * hand, and the picker edits it by machine. Both write a STRING
 * (`"codex:gpt-5.6-terra"`), which is why this replaced a module that located
 * an `engine: Codex({ ... })` call expression and spliced its arguments: a
 * string has no arguments to reconcile, no constructor to swap, and no options
 * that stop being valid when the provider changes.
 *
 * Located by AST and edited by byte offset, the same discipline the rest of
 * this directory uses. Parsing is what makes it reliable on a config that
 * nests; splicing rather than reprinting is what keeps the file the author's —
 * emitting from a syntax tree would reformat their code and drop their
 * comments.
 */

export type ModelSetResult = {
    /** False when the config already declared exactly this model. */
    changed: boolean
}

type ModelOpts = {
    root: string
}

export function Model(opts: ModelOpts) {
    const path = join(opts.root, "axon.config.ts")

    /** The `defineAgent({ ... })` object literal, or null when the config is not that shape. */
    function declaration(source: ts.SourceFile): ts.ObjectLiteralExpression | null {
        let found: ts.ObjectLiteralExpression | null = null

        tsast.visitCalls(source, "defineAgent", call => {
            if (found) return
            const argument = call.arguments[0]
            if (argument && tsc().isObjectLiteralExpression(argument)) found = argument
        })

        return found
    }

    return {
        path,

        /** The declared model string, or null when the agent declares none. */
        async get(): Promise<string | null> {
            const text = await readFile(path, "utf-8").catch(() => null)
            if (text === null) return null

            const source = tsast.parse(path, text)
            const object = declaration(source)
            if (!object) return null

            for (const property of object.properties) {
                if (!tsc().isPropertyAssignment(property)) continue
                if (property.name.getText(source) !== "model") continue
                if (!tsc().isStringLiteral(property.initializer)) continue
                return property.initializer.text
            }
            return null
        },

        /**
         * Write the model string, adding the field when it is absent.
         *
         * A no-op when the value already matches, so a picker re-selecting the
         * current model does not dirty the file or trigger a reload — the
         * caller reads `changed` to decide whether anything needs to happen.
         */
        async set(model: string): Promise<ModelSetResult> {
            const text = await readFile(path, "utf-8")
            const source = tsast.parse(path, text)
            const object = declaration(source)

            if (!object) {
                throw err("CONFIG_INVALID", {
                    detail: `${path} — no defineAgent({ ... }) call to edit`,
                    context: { path },
                })
            }

            for (const property of object.properties) {
                if (!tsc().isPropertyAssignment(property)) continue
                if (property.name.getText(source) !== "model") continue

                if (tsc().isStringLiteral(property.initializer) && property.initializer.text === model) {
                    return { changed: false }
                }

                const start = property.initializer.getStart(source)
                const end = property.initializer.getEnd()
                await writeFile(path, `${text.slice(0, start)}${JSON.stringify(model)}${text.slice(end)}`, "utf-8")
                return { changed: true }
            }

            // No `model:` yet — insert it as the FIRST property, where a reader
            // looks for what an agent runs on. Indentation is copied from the
            // property it sits above rather than assumed, so this lands
            // correctly in a config written with any style.
            const first = object.properties[0]
            const insertAt = first ? first.getStart(source) : object.getStart(source) + 1
            const indent = first
                ? text.slice(text.lastIndexOf("\n", insertAt) + 1, insertAt)
                : "    "
            const suffix = first ? `,\n${indent}` : "\n"

            await writeFile(
                path,
                `${text.slice(0, insertAt)}model: ${JSON.stringify(model)}${suffix}${text.slice(insertAt)}`,
                "utf-8",
            )
            return { changed: true }
        },
    }
}

export type ModelT = ReturnType<typeof Model>
