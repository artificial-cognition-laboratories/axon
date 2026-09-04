import { describe, expect, it } from "bun:test"
import { hasProcessGroups, killTree } from "../src/process/procs"

/**
 * The OS-specific branches, exercised on whatever machine runs the suite.
 *
 * ── Why these could not be tested before ────────────────────────────────────
 *
 * The repo carries 15 `process.platform` checks and, before this file, ZERO
 * tests touched a non-Linux branch. That is not a coverage gap in the ordinary
 * sense — those branches cannot execute on Linux CI at all, so they ship
 * unreviewed no matter how thorough the rest of the suite is. The macOS and
 * Windows failures that prompted this audit were both in exactly that class.
 *
 * The fix is not CI on three operating systems. It is naming the OS fact and
 * injecting it, so the decision it drives can be asserted for every shape from
 * one box. `hasProcessGroups` is that name; `killTree` takes it as a parameter.
 *
 * ── What is actually at stake here ──────────────────────────────────────────
 *
 * The capsule spawns through `shell: true`, so the child it holds is
 * `/bin/sh -c "<command>"` rather than the command itself. On POSIX the child
 * gets its own process group and `kill(-pid)` reaches the whole tree. On
 * Windows there is no group: `child.kill()` reaches the shell alone and the
 * real workload is orphaned — it survives kill(), interrupt() and shutdown().
 *
 * These tests pin that the two shapes stay DIFFERENT and that each does the
 * only thing available to it, so a change that collapses them is caught here
 * rather than by a user whose `sleep 30` outlived their session.
 */

/** A child stub that records how it was asked to die. */
function child(pid?: number) {
    const calls: string[] = []
    return {
        handle: { pid, kill: () => { calls.push("kill()") } },
        calls,
    }
}

describe("hasProcessGroups", () => {
    it("is true on POSIX, where a detached child gets its own group", () => {
        expect(hasProcessGroups("linux")).toBe(true)
        expect(hasProcessGroups("darwin")).toBe(true)
    })

    it("is false on Windows, which has no process groups to signal", () => {
        expect(hasProcessGroups("win32")).toBe(false)
    })
})

describe("killTree", () => {
    it("signals the whole GROUP where groups exist", () => {
        // The negative pid is the entire point: it reaches the shell AND the
        // command the shell started. Signalling the pid alone would leave the
        // workload running, which is the Windows behaviour and not something
        // POSIX should ever fall back to.
        const { handle, calls } = child(4321)
        const signalled: [number, string][] = []

        killTree(handle, true, (pid, sig) => { signalled.push([pid, sig]) })

        expect(signalled).toEqual([[-4321, "SIGKILL"]])
        expect(calls).toEqual([])
    })

    it("falls back to the direct child where groups do not exist", () => {
        // The Windows branch. Asserted not because it is good — it orphans
        // grandchildren — but because it is the only thing available there, and
        // a silent change to it would be invisible until a user reported a
        // process that would not die.
        const { handle, calls } = child(4321)
        const signalled: [number, string][] = []

        killTree(handle, false, (pid, sig) => { signalled.push([pid, sig]) })

        expect(signalled).toEqual([])
        expect(calls).toEqual(["kill()"])
    })

    it("falls back to the direct child when there is no pid to signal", () => {
        // A child that never launched has no group to address, whatever the OS.
        const { handle, calls } = child()
        const signalled: number[] = []

        killTree(handle, true, pid => { signalled.push(pid) })

        expect(signalled).toEqual([])
        expect(calls).toEqual(["kill()"])
    })

    it("treats an already-dead process as success, on either shape", () => {
        // ESRCH means the process is gone — which is the goal. Throwing would
        // turn a completed shutdown into a failed one.
        const gone = () => { throw new Error("ESRCH: no such process") }

        expect(() => killTree(child(4321).handle, true, gone)).not.toThrow()
        expect(() => killTree({ pid: 1, kill: gone }, false)).not.toThrow()
    })

    it("propagates a failure that is NOT the process being gone", () => {
        // A permission fault is a real problem and must not be swallowed —
        // silently "succeeding" at a kill that did not happen is how a process
        // survives a shutdown with nothing reporting it.
        const denied = () => { throw new Error("EPERM: operation not permitted") }

        expect(() => killTree(child(4321).handle, true, denied)).toThrow(/EPERM/)
    })
})
