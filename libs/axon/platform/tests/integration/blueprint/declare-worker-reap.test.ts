import { describe, expect, test } from "bun:test"

/**
 * The declare worker must not outlive the process that spawned it.
 *
 * ── The bug this pins ───────────────────────────────────────────────────────
 *
 * `DeclareServer` spawns a long-lived `bun` subprocess holding a TypeScript
 * compiler (~280MB RSS) and keeps it for the process lifetime — the right
 * design, since rebuilding a ts.Program per scan costs ~1s every time.
 *
 * It was spawned with `killSignal: "SIGKILL"` and a comment saying it "must
 * not outlive this process". That option does NOT do that: it only names the
 * signal `.kill()` sends when something calls it. Nothing ever did. A child is
 * not killed when its parent exits — it is reparented to init and keeps
 * running, so every Axon session left a ~280MB compiler behind. One was found
 * in the wild at 1h47m old with its parent long gone.
 *
 * The symptom users hit was worse than the memory: Axon runs inside an
 * editor's terminal, and processes that will not die make the editor's own
 * shutdown hang. "Closing the terminal freezes my editor" was this.
 *
 * ── Why this test spawns a real process ─────────────────────────────────────
 *
 * The whole failure lives in OS process semantics — what happens to a child
 * when its parent exits. A mocked spawn would assert that we call `.kill()`,
 * which is not the property that broke: the property is that no worker is
 * still running afterwards, and only a real fork can show that.
 */

/** PIDs of every live declare-worker, via pgrep. Empty when none. */
async function liveWorkers(): Promise<string[]> {
    const found = await Bun.$`pgrep -f "declare-worker.*--serve"`.text().catch(() => "")
    return found.trim().split("\n").filter(Boolean)
}

describe("declare worker: bounded by its parent's life", () => {
    test("no worker survives the process that spawned it", async () => {
        const before = new Set(await liveWorkers())

        // A real child process, exiting the way the TUI does: normally, with
        // no explicit kill. Runs the actual DeclareServer rather than a stand
        // in, so the reaper under test is the one that ships.
        //
        // The root must genuinely CONTAIN tools, and they must not already be
        // cached — otherwise the scan short-circuits, no worker is spawned,
        // and the test passes without exercising anything. A fresh temp dir
        // with one tool file guarantees a cache miss and therefore a spawn.
        const script = `
            import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
            import { tmpdir } from "node:os"
            import { join } from "node:path"

            const root = await mkdtemp(join(tmpdir(), "axon-reap-"))
            await mkdir(join(root, "src", "tools"), { recursive: true })
            await writeFile(
                join(root, "src", "tools", "probe.ts"),
                "export function probe(): string { return 'x' }\\n",
            )

            const { Tools } = await import("${import.meta.dir}/../../../src/build/blueprint/scan/tools.ts")
            const scanned = await Tools(root, { required: false })
            // Fail loudly rather than silently skipping: a scan that produced
            // no tools spawned no worker, and would make this test vacuous.
            if (scanned.entries.length === 0) {
                console.error("SPAWN-CHECK-FAILED: scan produced no tools")
                process.exit(3)
            }
            process.exit(0)
        `
        const child = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" })
        const exitCode = await child.exited
        const stderr = await new Response(child.stderr).text()

        // The child must have actually scanned something, or this proves
        // nothing about reaping.
        expect({ exitCode, stderr }).toMatchObject({ exitCode: 0 })

        // Reaping is a signal send on the way out; give the OS a moment to
        // finish tearing the process down before looking.
        await Bun.sleep(500)

        const after = await liveWorkers()
        const leaked = after.filter(pid => !before.has(pid))

        // Clean up before asserting — a failing run must not leave the very
        // process it is complaining about behind for the next one.
        for (const pid of leaked) {
            try { process.kill(Number(pid), "SIGKILL") } catch { /* already gone */ }
        }

        expect(leaked).toEqual([])
    }, 120_000)
})
