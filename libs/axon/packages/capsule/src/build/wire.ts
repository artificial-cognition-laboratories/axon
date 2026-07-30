import { err } from "@arcforge/err"
import type { CapsuleCommand } from "../../types"
import type { CapsuleBusT } from "../../platform/bus"
import { isCapsuleEvent } from "../../platform/guard"
import type { SpawnedChild } from "./spawn"

const STDERR_RING_MAX = 100
const RECOVERY_BUFFER_MAX = 1_048_576 // 1MB

export type WireT = {
    send(cmd: CapsuleCommand): void
    /** Crash context — the last stderr lines the subprocess wrote. */
    stderr(): string
    /** Detach all stream listeners. Idempotent. */
    detach(): void
}

type WireOpts = {
    child: SpawnedChild
    bus: CapsuleBusT
}

/**
 * Wire — the ONLY code that touches the subprocess stdio, both directions.
 *
 * Inbound:  stdout JSONL → parse (with multi-line recovery) → validate
 *           against the CapsuleEvent guard → bus. Garbage becomes
 *           capsule:parse:error — never silently dropped.
 * Outbound: send(cmd) → stringify + newline → stdin. Throws when the pipe
 *           is gone — nothing queues silently.
 *
 * stderr is not protocol: it feeds a bounded ring used as crash context.
 * Child exit → capsule:exit on the bus (the supervisor's crash signal).
 */
export function Wire(opts: WireOpts): WireT {
    const { child, bus } = opts
    const proc = child.proc

    let detached = false
    const stderrRing: string[] = []

    // ── Inbound: stdout → events ─────────────────────────────────────────────
    let lineBuffer = ""
    // Pretty-printed / multi-line JSON recovery: accumulate lines until they
    // parse as one document, capped so garbage can't grow unbounded.
    let recovery = ""

    function handleLine(line: string) {
        if (!line.trim()) return

        const candidate = recovery ? recovery + "\n" + line : line
        let parsed: unknown
        try {
            parsed = JSON.parse(candidate)
            recovery = ""
        } catch {
            try {
                parsed = JSON.parse(line)
                recovery = ""
            } catch {
                recovery = candidate
                if (recovery.length > RECOVERY_BUFFER_MAX) {
                    bus.emit("capsule:parse:error", { error: err("CAPSULE_PARSE_ERROR", { detail: "recovery buffer exceeded 1MB, discarding" }).toJSON() })
                    recovery = ""
                }
                return
            }
        }

        if (parsed === null || typeof parsed !== "object") {
            bus.emit("capsule:parse:error", { error: err("CAPSULE_PARSE_ERROR", { detail: "non-object protocol line" }).toJSON(), line })
            return
        }

        if (!isCapsuleEvent(parsed)) {
            bus.emit("capsule:parse:error", { error: err("CAPSULE_PARSE_ERROR", { detail: "invalid event shape" }).toJSON(), line })
            return
        }

        const { type, ...data } = parsed
        bus.emit(type, data as never)
    }

    function onStdout(chunk: Buffer) {
        lineBuffer += chunk.toString()
        const lines = lineBuffer.split(/\r?\n/)
        lineBuffer = lines.pop() ?? ""
        for (const line of lines) handleLine(line)
    }

    function onStderr(chunk: Buffer) {
        stderrRing.push(chunk.toString())
        if (stderrRing.length > STDERR_RING_MAX) stderrRing.shift()
    }

    function onExit(code: number | null) {
        bus.emit("capsule:exit", { code })
    }

    proc.stdout!.on("data", onStdout)
    proc.stderr!.on("data", onStderr)
    proc.on("exit", onExit)

    // Spawn failures surface asynchronously — a child that never started
    // reports here, and the supervisor sees it as an exit.
    function onError(err: Error) {
        stderrRing.push(`[spawn error] ${err.message}\n`)
        bus.emit("capsule:exit", { code: null, reason: err.message })
    }
    proc.on("error", onError)

    return {
        send(cmd: CapsuleCommand) {
            if (detached || !proc.stdin?.writable) {
                throw err("CAPSULE_WIRE_CLOSED", { context: { cmd: cmd.type } })
            }
            proc.stdin.write(JSON.stringify(cmd) + "\n")
        },

        stderr() {
            return stderrRing.join("")
        },

        detach() {
            if (detached) return
            detached = true
            proc.stdout?.removeListener("data", onStdout)
            proc.stderr?.removeListener("data", onStderr)
            proc.removeListener("exit", onExit)
            proc.removeListener("error", onError)
        },
    }
}
