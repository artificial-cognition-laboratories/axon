import { describe, expect, test } from "bun:test"
import { classifyCommand } from "../../../src/process/command-activity"

const CASES = [
    ["rg \"Renderer.capture\" libs/axon", "file:search", { query: "Renderer.capture", scope: "libs/axon" }],
    ["cat apps/tui/app/pages/index.vue", "file:read", { path: "apps/tui/app/pages/index.vue" }],
    ["ls apps/tui", "file:list", { path: "apps/tui" }],
    ["mkdir -p apps/tui/tmp", "file:write", { path: "apps/tui/tmp" }],
    ["rm stale.txt", "file:delete", { path: "stale.txt" }],
    ["mv old.ts new.ts", "file:move", { from: "old.ts", to: "new.ts" }],
    ["git status", "vcs:status", {}],
    ["git diff --stat", "vcs:diff", { args: "diff --stat" }],
    ["curl -X POST https://api.example.com/run", "http", { method: "POST", url: "https://api.example.com/run" }],
    ["bun test tests/hot", "proc:exec", { command: "bun test tests/hot" }],
] as const satisfies ReadonlyArray<readonly [string, ReturnType<typeof classifyCommand>["type"], Record<string, unknown>]>

describe("CommandActivity", () => {
    test.each(CASES)("classifies %s", (command, type, data) => {
        expect(classifyCommand(command)).toEqual({ type, data })
    })

    test("keeps a shell chain as one honest command", () => {
        expect(classifyCommand("git status && bun test")).toEqual({
            type: "proc:exec",
            data: { command: "git status && bun test" },
        })
    })
})
