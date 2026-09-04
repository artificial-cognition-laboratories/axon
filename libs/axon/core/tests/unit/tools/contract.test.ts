import { afterAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Tools } from "../../../src/tools"
import type { MediateOpts } from "../../../src/tools"
import type { AxonTool } from "@arcforge/types"

/**
 * Where these tools materialize. A real directory the test owns, because
 * `scratch` is REQUIRED now: the agent derives it from its own frame rather
 * than reading `os.tmpdir()`, which resolved differently inside the agent
 * process than on the host and stopped agents booting on macOS entirely.
 * Supplying it here is the same thing the runtime does.
 */
const scratch = mkdtempSync(join(tmpdir(), "core-tools-"))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/**
 * The tool contract, pinned.
 *
 * Two rules that are easy to state and were, until recently, implemented
 * three different ways in three places:
 *
 *   PLACEMENT — every export from `src/tools/*.ts` lands in the agent's
 *   global scope under its OWN name. The file it came from groups it for a
 *   reader; it never namespaces it. `export function add()` is `add()`;
 *   `export const fs = {...}` is `fs.read()`.
 *
 *   ADDRESSING — a policy rule is written against `<tool>.<export>`. That is
 *   deliberately NOT the call path: the caller says `read(...)`, the mediator
 *   asks about `fs.read`. Flattening the address would make one rule cover
 *   every module that happens to export `read`.
 *
 * The two disagreeing is a silent permission change — a rule that binds in
 * one enforcement path and not the other — which is exactly what happened
 * while `core/tools/load.ts` used the bare name and the capsule used the
 * namespaced one. The capsule's own suite asserts the same pair from its
 * side; these must agree with it.
 */

function recorder(verdict: (fn: string) => boolean = () => true) {
    const checks: string[] = []
    const mediation: MediateOpts = {
        async check(fn) {
            checks.push(fn)
            return verdict(fn)
        },
        emit: { start: () => {}, complete: () => {}, failed: () => {} },
    }
    return { mediation, checks }
}

function tool(over: Partial<AxonTool> & { name: string; source: string }): AxonTool {
    return { origin: "src", fns: [], ...over } as AxonTool
}

describe("tool contract — placement", () => {
    it("a bare function export is callable under its own name", async () => {
        const { mediation } = recorder()
        const tools = Tools({ mediation, scratch })
        await tools.install([tool({
            name: "math",
            fns: [{ name: "add", declaration: "function add(a: number, b: number): Promise<number>" }],
            source: `export const add = (a, b) => a + b`,
        })])

        const globals = tools.globals() as { add(a: number, b: number): Promise<number> }
        expect(await globals.add(2, 3)).toBe(5)
    })

    it("an object export keeps its members under the object, not the filename", async () => {
        // The `@axon/fs` shape: one export named for the bag it carries.
        // `fs.read()` — never `fs.fs.read()`, which is what treating the
        // filename as a namespace produced.
        const { mediation } = recorder()
        const tools = Tools({ mediation, scratch })
        await tools.install([tool({
            name: "fs",
            fns: [{ name: "fs", declaration: "const fs: { read(): Promise<string> }" }],
            source: `export const fs = { read: async () => "contents" }`,
        })])

        const globals = tools.globals() as { fs: { read(): Promise<string> } }
        expect(await globals.fs.read()).toBe("contents")
    })

    it("the filename never becomes a namespace", async () => {
        const { mediation } = recorder()
        const tools = Tools({ mediation, scratch })
        await tools.install([tool({
            name: "greeter",
            fns: [{ name: "greet", declaration: "function greet(): Promise<string>" }],
            source: `export const greet = async () => "hi"`,
        })])

        const globals = tools.globals() as Record<string, unknown>
        expect(Object.keys(globals)).toEqual(["greet"])
        expect(globals.greeter).toBeUndefined()
    })

    it("two files' exports coexist, each under its own name", async () => {
        const { mediation } = recorder()
        const tools = Tools({ mediation, scratch })
        await tools.install([
            tool({
                name: "math",
                fns: [{ name: "add", declaration: "function add(): Promise<number>" }],
                source: `export const add = async () => 1`,
            }),
            tool({
                name: "text",
                fns: [{ name: "upper", declaration: "function upper(): Promise<string>" }],
                source: `export const upper = async () => "X"`,
            }),
        ])

        const globals = tools.globals() as Record<string, unknown>
        expect(Object.keys(globals).sort()).toEqual(["add", "upper"])
    })
})

describe("tool contract — policy addressing", () => {
    it("addresses a call as <tool>.<export>, not by its call path", async () => {
        const { mediation, checks } = recorder()
        const tools = Tools({ mediation, scratch })
        await tools.install([tool({
            name: "fs",
            fns: [{ name: "read", declaration: "function read(): Promise<string>" }],
            source: `export const read = async () => "ok"`,
        })])

        await (tools.globals() as { read(): Promise<string> }).read()

        // The caller said `read()`; policy was asked about `fs.read`.
        expect(checks).toEqual(["fs.read"])
    })

    it("addresses a nested member one level down from its export", async () => {
        const { mediation, checks } = recorder()
        const tools = Tools({ mediation, scratch })
        await tools.install([tool({
            name: "fs",
            fns: [{ name: "fs", declaration: "const fs: { read(): Promise<string> }" }],
            source: `export const fs = { read: async () => "ok" }`,
        })])

        await (tools.globals() as { fs: { read(): Promise<string> } }).fs.read()

        expect(checks).toEqual(["fs.fs.read"])
    })

    it("two files exporting the same name address separately", async () => {
        // The reason the address stays namespaced: a bare `read` would make
        // one policy rule cover both of these.
        const { mediation, checks } = recorder()
        const tools = Tools({ mediation, scratch })
        await tools.install([
            tool({
                name: "fs",
                fns: [{ name: "read", declaration: "function read(): Promise<string>" }],
                source: `export const read = async () => "disk"`,
            }),
        ])
        await (tools.globals() as { read(): Promise<string> }).read()

        const second = Tools({ mediation, scratch })
        await second.install([
            tool({
                name: "net",
                fns: [{ name: "read", declaration: "function read(): Promise<string>" }],
                source: `export const read = async () => "wire"`,
            }),
        ])
        await (second.globals() as { read(): Promise<string> }).read()

        expect(checks).toEqual(["fs.read", "net.read"])
    })

    it("a denied call never runs the function body", async () => {
        const { mediation } = recorder(fn => fn !== "danger.fire")
        const tools = Tools({ mediation, scratch })
        await tools.install([tool({
            name: "danger",
            fns: [{ name: "fire", declaration: "function fire(): Promise<void>" }],
            // Writing to globalThis is observable without reaching into the
            // loader: if the body ran, the flag is set.
            source: `export const fire = async () => { globalThis.__fired = true }`,
        })])

        ;(globalThis as Record<string, unknown>).__fired = false
        await expect((tools.globals() as { fire(): Promise<void> }).fire())
            .rejects.toThrow(/CAPSULE_POLICY_DENIED/)
        expect((globalThis as Record<string, unknown>).__fired).toBe(false)
    })
})
