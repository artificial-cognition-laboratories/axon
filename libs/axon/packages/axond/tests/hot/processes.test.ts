import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Processes } from "../../src/labs/processes"

const dir = mkdtempSync(join(tmpdir(), "axon-process-logs-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

test("a restarted process leaves only its current run in the log", async () => {
    const log = join(dir, "stream.log")
    const processes = Processes({ ledger: join(dir, "pids.json") })
    writeFileSync(log, "previous run had a much longer diagnostic line\n")

    const child = processes.spawn({ label: "stream", cmd: ["printf", "current run\n"], stdout: log })
    expect(await child.exited).toBe(0)
    expect(readFileSync(log, "utf-8")).toBe("current run\n")
})
