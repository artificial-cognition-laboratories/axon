import { expect, it } from "bun:test"
import { join } from "node:path"

/**
 * The Python runtime's own contract test — the kernel surface it implements
 * and every message of the conversation, from `tests/contract/` — run with the
 * rest, so `bun test` proves every language against the same files.
 */
it("holds the Python runtime to the pinned contract", () => {
    const script = join(import.meta.dir, "..", "..", "python", "tests", "test_contract.py")
    const run = Bun.spawnSync(["python3", script], { stdout: "pipe", stderr: "pipe" })
    expect(run.exitCode, new TextDecoder().decode(run.stderr)).toBe(0)
})
