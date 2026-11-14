import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Rest } from "../../src/labs/body/index"
import { Processes } from "../../src/labs/processes"

/** The kernel's own word for a process: R running, S sleeping, T stopped. */
function stateOf(pid: number): string {
    return readFileSync(`/proc/${pid}/stat`, "utf-8").split(") ")[1]!.charAt(0)
}

describe("rest — a warm body frozen for real", () => {
    test("stops the whole group while resting, resumes it on waking, and still stops cleanly", async () => {
        const processes = Processes({ ledger: join(mkdtempSync(join(tmpdir(), "axon-rest-")), "pids.json") })
        const rest = Rest()
        const proc = rest.hold(processes.spawn({ label: "worker", cmd: ["sleep", "30"] }))
        await Bun.sleep(50)

        rest.rest()
        await Bun.sleep(50)
        expect(stateOf(proc.pid)).toBe("T")

        rest.wake()
        await Bun.sleep(50)
        expect(stateOf(proc.pid)).not.toBe("T")

        // A frozen group cannot act on SIGTERM — a body wakes before it stops.
        rest.rest()
        rest.wake()
        proc.kill("SIGTERM")
        expect(await Promise.race([proc.exited.then(() => "exited"), Bun.sleep(2_000).then(() => "stuck")])).toBe("exited")
    })
})
