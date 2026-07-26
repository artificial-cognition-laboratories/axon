import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AxonModule } from "@arcforge/types"
import { Axon } from "../../setup/axon"

/**
 * Module setup executor — behaviour-driven. A module's setup() must run at
 * boot with its validated options and a live axon handle, and its onDispose()
 * teardown must run on shutdown. We verify through side-effects the module
 * writes to disk (never by reaching into executor internals) and through the
 * session log's determinism ledger.
 */
describe("Module setup executor", () => {
    let dir: string

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), "axon-module-test-"))
    })
    afterEach(async () => {
        await rm(dir, { recursive: true, force: true })
    })

    /** Write a module.config.ts whose setup writes a marker file, and return an AxonModule pointing at it. */
    async function makeModule(opts: { name: string; body: string; optionsSchema?: AxonModule["optionsSchema"]; options?: Record<string, unknown> }): Promise<AxonModule> {
        const configPath = join(dir, `${opts.name}.config.ts`)
        await writeFile(configPath, `export default { ${opts.body} }\n`)
        return {
            name: opts.name,
            root: dir,
            configPath,
            automerge: true,
            env: {},
            optionsSchema: opts.optionsSchema ?? {},
            ...(opts.options ? { options: opts.options } : {}),
            prompts: [],
            scripts: [],
            tools: [],
        }
    }

    it("runs a module's setup() at boot", async () => {
        const marker = join(dir, "setup-ran")
        const module = await makeModule({
            name: "spy",
            body: `setup: async ({ axon, options }) => { await Bun.write(${JSON.stringify(marker)}, "yes") }`,
        })

        const runtime = await Axon({ blueprint: { modules: [module] } })

        const contents = await readFile(marker, "utf-8")
        expect(contents).toBe("yes")

        await runtime.shutdown()
    })

    it("passes validated options (with defaults applied) into setup()", async () => {
        const marker = join(dir, "options.json")
        const module = await makeModule({
            name: "opts",
            body: `setup: async ({ options }) => { await Bun.write(${JSON.stringify(marker)}, JSON.stringify(options)) }`,
            optionsSchema: {
                greeting: { type: "string", default: "hi" },
                loud: { type: "boolean", required: false },
            },
            options: { loud: true },
        })

        const runtime = await Axon({ blueprint: { modules: [module] } })

        const options = JSON.parse(await readFile(marker, "utf-8"))
        expect(options).toEqual({ greeting: "hi", loud: true })

        await runtime.shutdown()
    })

    it("runs onDispose() teardown on shutdown", async () => {
        const marker = join(dir, "disposed")
        const module = await makeModule({
            name: "disposer",
            body: `setup: ({ axon }) => { axon.onDispose(async () => { await Bun.write(${JSON.stringify(marker)}, "torn-down") }) }`,
        })

        const runtime = await Axon({ blueprint: { modules: [module] } })
        // Not yet disposed.
        expect(await readFile(marker, "utf-8").catch(() => null)).toBeNull()

        await runtime.shutdown()

        expect(await readFile(marker, "utf-8")).toBe("torn-down")
    })

    it("commits module:setup:start and module:setup:complete to the session log, in order", async () => {
        const module = await makeModule({ name: "ledger", body: `setup: () => {}` })

        const runtime = await Axon({ blueprint: { modules: [module] } })

        const types = runtime.session.log.map(e => e.type)
        const start = types.indexOf("module:setup:start")
        const complete = types.indexOf("module:setup:complete")
        expect(start).toBeGreaterThan(-1)
        expect(complete).toBeGreaterThan(start)

        await runtime.shutdown()
    })

    it("fails boot loudly when a module's setup() throws", async () => {
        const module = await makeModule({
            name: "boom",
            body: `setup: () => { throw new Error("setup exploded") }`,
        })

        await expect(Axon({ blueprint: { modules: [module] } })).rejects.toThrow()
    })

    it("fails boot when a required option is missing", async () => {
        const module = await makeModule({
            name: "needsopt",
            body: `setup: () => {}`,
            optionsSchema: { token: { type: "string", required: true } },
        })

        await expect(Axon({ blueprint: { modules: [module] } })).rejects.toThrow()
    })

    it("re-runs setup on hot-reload after disposing the previous instance (reload == shutdown+boot)", async () => {
        // The module appends a line per setup and per dispose, so the file
        // records the exact lifecycle sequence across a reload.
        const log = join(dir, "lifecycle.log")
        const module = await makeModule({
            name: "reloadable",
            body: `setup: ({ axon }) => {
                const { appendFileSync } = require("fs")
                appendFileSync(${JSON.stringify(log)}, "setup\\n")
                axon.onDispose(() => { appendFileSync(${JSON.stringify(log)}, "dispose\\n") })
            }`,
        })

        const runtime = await Axon({ blueprint: { modules: [module] } })
        await runtime.update({ modules: [module] })

        const sequence = (await readFile(log, "utf-8")).trim().split("\n")
        // boot setup, then reload disposes the old, then sets up the new.
        expect(sequence).toEqual(["setup", "dispose", "setup"])

        await runtime.shutdown()

        const final = (await readFile(log, "utf-8")).trim().split("\n")
        expect(final).toEqual(["setup", "dispose", "setup", "dispose"])
    })
})
