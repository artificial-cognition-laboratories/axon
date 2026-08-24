import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { TUI_CONTRACT } from "../src/tui-contract"

const SRC = join(import.meta.dir, "..", "src", "tui.ts")

/**
 * `src/tui-contract.ts` is generated from `src/tui.ts` by scripts/contract.ts
 * and committed, because `axon prepare` reads it at runtime to write a
 * profile's ambient globals.
 *
 * Generated-and-committed is exactly the arrangement that goes stale silently:
 * nothing in the release pipeline regenerates it, so an edit to tui.ts that
 * skips `bun run contract` ships a contract the user's editor disagrees with —
 * autocomplete for an API that no longer exists, and no error anywhere. These
 * tests are that alarm.
 */
describe("tui contract", () => {
    test("tui.ts has no imports", () => {
        // The whole reason the generated form can exist. A profile directory
        // has no node_modules, so an import in the copied text would resolve to
        // nothing — and the failure would surface in a user's editor as every
        // symbol degrading to any, far from the cause.
        const imports = readFileSync(SRC, "utf-8")
            .split("\n")
            .filter(line => /^\s*import\s/.test(line))

        expect(imports).toEqual([])
    })

    test("the generated contract is current", () => {
        const expected = readFileSync(SRC, "utf-8")
            .split("\n")
            .map(line => line.replace(/^export (type|function|const|interface) /, "$1 "))
            .map(line => (line.length > 0 ? `    ${line}` : line))
            .join("\n")
            .trimEnd()

        expect(TUI_CONTRACT).toBe(expected)
    })

    test("carries the surface a profile is written against", () => {
        // A smoke check on the copy itself: if the transform ever mangles the
        // text, this fails here rather than in a scaffolded profile.
        // Every namespace an extension reaches for is `Axon*` — one spelling,
        // no exceptions. This list is what catches a rename leaving the
        // generated globals behind, which is exactly how six of these once
        // silently degraded to `any` in every profile.
        for (const name of ["AxonTui", "AxonPalette", "AxonCommands", "AxonKeys", "AxonMode", "AxonInput", "AxonAgents"]) {
            expect(TUI_CONTRACT).toContain(`type ${name} =`)
        }
        expect(TUI_CONTRACT).toContain("type ExtensionConfig")
        expect(TUI_CONTRACT).toContain("type ProfileConfig")

        // `export` is stripped — the declarations live inside `declare global`,
        // where an export would be a syntax error.
        expect(TUI_CONTRACT).not.toContain("export type")
    })
})
