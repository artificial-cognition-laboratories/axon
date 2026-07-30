import type { AnyCapsuleEvent, CapsuleCommand, CapsuleEventName, CapsuleEvent } from "../../types"

export type SandboxWireT = {
    /** Emit an event to the host over stdout. */
    emit<K extends CapsuleEventName>(type: K, data: CapsuleEvent[K]): void
    /** Subscribe to inbound commands from the host. */
    onCommand(handler: (cmd: CapsuleCommand) => void): () => void
}

/**
 * SandboxWire — the subprocess side of the wire, mirroring the host's Wire.
 *
 * Inbound: stdin JSONL → CapsuleCommand → handler. Outbound: emit(type, data)
 * → JSONL → stdout. Speaks the current protocol names directly — no legacy
 * translation (that shim exists only on the host side, for a program that no
 * longer exists once this one ships).
 *
 * stdout is the protocol wire and nothing else — any stray console.log from
 * a loaded tool or run() body must never reach it directly, only through
 * capsule:console.
 */
export function SandboxWire(): SandboxWireT {
    const handlers = new Set<(cmd: CapsuleCommand) => void>()
    // Capture before installScope redirects model-facing stdout. This bound
    // writer is the sole capability allowed to touch the JSONL transport.
    const protocolWrite = process.stdout.write.bind(process.stdout)

    let buffer = ""
    process.stdin.on("data", (chunk: Buffer) => {
        buffer += chunk.toString()
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ""
        for (const line of lines) {
            if (!line.trim()) continue
            let parsed: unknown
            try {
                parsed = JSON.parse(line)
            } catch {
                continue // garbage on stdin — nothing to report it to but the host, which sent it
            }
            for (const handler of [...handlers]) handler(parsed as CapsuleCommand)
        }
    })

    return {
        emit<K extends CapsuleEventName>(type: K, data: CapsuleEvent[K]) {
            const event = { type, ...data } as AnyCapsuleEvent
            // JSON.stringify drops keys whose value is undefined — a run()
            // that legitimately returns undefined would silently lose the
            // "result" key and fail the host's isCapsuleEvent guard. The
            // replacer normalizes undefined to null, JSON's nearest faithful
            // encoding, everywhere in the payload.
            protocolWrite(JSON.stringify(event, (_key, value) => value === undefined ? null : value) + "\n")
        },

        onCommand(handler: (cmd: CapsuleCommand) => void): () => void {
            handlers.add(handler)
            return () => handlers.delete(handler)
        },
    }
}
