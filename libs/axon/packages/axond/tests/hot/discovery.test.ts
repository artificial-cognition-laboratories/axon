import { afterEach, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { errorMap } from "@arcforge/err"
import { Agents } from "../../src/agents/index"
import { Projects } from "../../src/agents/projects"

/**
 * Discovery is an inventory a remote machine will read. "No agents" must mean
 * there are none — never that the store could not be read.
 */
let scratch: string | null = null

afterEach(() => {
    if (scratch) {
        chmodSync(join(scratch, ".axon", "profiles", "me", "agents"), 0o755)
        rmSync(scratch, { recursive: true, force: true })
        scratch = null
    }
})

function store(): string {
    scratch = mkdtempSync(join(tmpdir(), "axond-discovery-"))
    const agent = join(scratch, ".axon", "profiles", "me", "agents", "zeno")
    mkdirSync(agent, { recursive: true })
    writeFileSync(join(agent, "axon.config.ts"), "export default {}")
    return agent
}

test("an absent store is an empty inventory", () => {
    const empty = mkdtempSync(join(tmpdir(), "axond-discovery-empty-"))
    expect(Projects({ stores: [join(empty, ".axon")] }).list()).toEqual([])
    rmSync(empty, { recursive: true })
})

test("an unreadable agents directory throws instead of reading as empty", () => {
    const agent = store()
    expect(Projects({ stores: [join(scratch!, ".axon")] }).list().map(found => found.name)).toEqual(["zeno"])
    chmodSync(join(agent, ".."), 0o000)
    expect(() => Projects({ stores: [join(scratch!, ".axon")] }).list()).toThrow(expect.objectContaining({ code: errorMap.FILE_UNREADABLE.code }))
})

test("a malformed package.json throws instead of reading as unscoped", () => {
    const agent = store()
    writeFileSync(join(agent, "package.json"), "{ not json")
    expect(() => Projects({ stores: [join(scratch!, ".axon")] }).list()).toThrow(expect.objectContaining({ code: errorMap.FILE_UNREADABLE.code }))
})

test("own inventory speaks only for this distribution's store", () => {
    store()
    const dev = join(scratch!, ".axon-dev", "profiles", "me", "agents", "ember")
    mkdirSync(dev, { recursive: true })
    writeFileSync(join(dev, "axon.config.ts"), "export default {}")

    const agents = Agents({
        store: join(scratch!, ".axon"),
        stores: [join(scratch!, ".axon"), join(scratch!, ".axon-dev")],
        root: join(scratch!, ".axon", "cache", "running"),
        isolated: true,
    })
    expect(agents.installed().map(found => found.name).sort()).toEqual(["ember", "zeno"])
    expect(agents.own.installed().map(found => found.name)).toEqual(["zeno"])
})
