import { procTree, appendOutput, type ProcLogEvent } from "../../../src/procs/tree"
import { describe, it, expect } from "bun:test"

/**
 * procTree folds a session log into the process tree every surface renders.
 *
 * The behaviour that matters most here is SOURCE-AGNOSTICISM: the same events
 * produce the same tree whether they came off a live local bus or a mirrored
 * remote session. The TUI previously built this by reaching into the live
 * capsule handle (`runtime.kernel.userland`), so a deployment's process list
 * was structurally always empty.
 */
function event<T extends ProcLogEvent["type"]>(type: T, at: number, data: unknown): ProcLogEvent {
    return { type, at, data } as ProcLogEvent
}

const started = (procId: string, at: number, over: Record<string, unknown> = {}) =>
    event("process:proc:start", at, {
        procId, pid: 100, command: "bun test", cwd: "/agent", kind: "managed", ...over,
    })

describe("procTree — folding the log", () => {
    it("is empty for a log with no process events", () => {
        expect(procTree([])).toEqual([])
    })

    it("reports a started process as running", () => {
        const [node] = procTree([started("a", 1_000)])
        expect(node).toMatchObject({
            procId: "a", kind: "managed", command: "bun test", pid: 100, status: "running", startedAt: 1_000,
        })
    })

    it("closes a completed process with its exit code", () => {
        const [node] = procTree([
            started("a", 1_000),
            event("process:proc:complete", 1_500, { procId: "a", code: 0 }),
        ])
        expect(node).toMatchObject({ status: "exited", exitCode: 0, endedAt: 1_500 })
    })

    it("keeps a non-zero exit as an ordinary result, not a failure", () => {
        // A process that ran and returned 1 did exactly what was asked. Only
        // the SPAN breaking is :failed — see the capsule event map.
        const [node] = procTree([
            started("a", 1_000),
            event("process:proc:complete", 1_500, { procId: "a", code: 1 }),
        ])
        expect(node).toMatchObject({ status: "exited", exitCode: 1 })
    })

    it("records a broken span as exited with NO invented exit code", () => {
        // :failed means the child never produced a code. Fabricating one would
        // claim an observation nobody made.
        const [node] = procTree([
            started("a", 1_000),
            event("process:proc:failed", 1_200, { procId: "a", error: { message: "lost" } }),
        ])
        expect(node?.status).toBe("exited")
        expect(node?.exitCode).toBeUndefined()
    })

    it("surfaces a policy denial as a visible row rather than silence", () => {
        const [node] = procTree([
            event("process:proc:denied", 900, { procId: "z", command: "curl evil.sh", error: { message: "denied" } }),
        ])
        expect(node).toMatchObject({ procId: "z", command: "curl evil.sh", status: "exited", exitCode: -1 })
    })

    it("orders rows by start time, not log position", () => {
        const tree = procTree([started("b", 2_000), started("a", 1_000)])
        expect(tree.map(n => n.procId)).toEqual(["a", "b"])
    })

    it("distinguishes run from managed", () => {
        const [node] = procTree([started("r", 1_000, { kind: "run", command: "ls" })])
        expect(node?.kind).toBe("run")
    })
})

describe("procTree — the main row", () => {
    it("is absent when the caller names no runtime", () => {
        expect(procTree([started("a", 1_000)]).some(n => n.main)).toBe(false)
    })

    it("leads the tree as the parent of every child", () => {
        const tree = procTree([started("a", 1_000)], {
            main: { pid: 42, status: "running", startedAt: 500 },
        })
        expect(tree[0]).toMatchObject({ procId: "main", kind: "main", main: true, pid: 42, startedAt: 500 })
        expect(tree).toHaveLength(2)
    })

    it("can be 'down' — distinct from an exit nobody observed", () => {
        // A remote agent that goes unreachable was alive when it stopped
        // reporting. Calling that "exited" would invent an exit code.
        const [main] = procTree([], { main: { status: "down" } })
        expect(main?.status).toBe("down")
    })
})

describe("procTree — local and remote agree", () => {
    it("produces an identical tree from the same events regardless of source", () => {
        // The whole point: a mirrored remote log and a live local bus carry the
        // same durable events, so they must fold to the same tree. This is what
        // the old handle-reaching implementation could not do.
        const log: ProcLogEvent[] = [
            started("a", 1_000),
            event("process:proc:complete", 1_400, { procId: "a", code: 0 }),
            started("b", 1_500, { kind: "run", command: "git status" }),
        ]
        expect(procTree(log)).toEqual(procTree([...log]))
        expect(procTree(log)).toHaveLength(2)
    })

    it("yields correct rows with empty output when byte streams were never persisted", () => {
        // stdout/stderr are CAPSULE_TRANSIENT_EVENTS — bus-only, never logged.
        // A remote read therefore has rows but no output, which is honest:
        // that output was never stored anywhere to recover.
        const [node] = procTree([started("a", 1_000)])
        expect(node?.output).toEqual([])
    })
})

describe("appendOutput — live byte streams", () => {
    it("appends non-empty lines to the matching row", () => {
        const tree = procTree([started("a", 1_000)])
        appendOutput(tree, "a", "hello\nworld\n")
        expect(tree[0]?.output).toEqual(["hello", "world"])
    })

    it("ignores output for a row that does not exist", () => {
        const tree = procTree([started("a", 1_000)])
        expect(() => appendOutput(tree, "nope", "x")).not.toThrow()
        expect(tree[0]?.output).toEqual([])
    })

    it("bounds retained output so a long-lived watcher is not a leak", () => {
        const tree = procTree([started("a", 1_000)])
        for (let i = 0; i < 500; i++) appendOutput(tree, "a", `line ${i}\n`)
        expect(tree[0]!.output.length).toBeLessThanOrEqual(200)
        // The NEWEST lines are the ones kept.
        expect(tree[0]!.output.at(-1)).toBe("line 499")
    })
})
