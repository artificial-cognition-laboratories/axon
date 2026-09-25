import { randomUUID } from "node:crypto"

export type ControlOpts = {
    /** ws://127.0.0.1:<port>/bridge */
    endpoint: string
    /** Every session change the client reports: "menu", "joining", "in-world". */
    onSession(state: string): void
    onClose(): void
}

type Pending = { resolve: (value: CommandResult) => void; reject: (cause: Error) => void; timer: ReturnType<typeof setTimeout> }

export type CommandResult = { ok: boolean; error?: string; state: string; endpoint: string | null }

/**
 * Control — the lab's own line into a body.
 *
 * AxonT's bridge accepts several connections, and this is the lab's: it joins,
 * leaves and creates characters. The agent that leases the body opens its own
 * connection for senses and muscles. Keeping them apart means an agent
 * reloading its brain — dropping its socket — never disturbs the body's place
 * in the world.
 */
export function Control(opts: ControlOpts) {
    const pending = new Map<string, Pending>()
    let socket: WebSocket | null = null

    function fail(reason: string): void {
        for (const [id, entry] of pending) {
            clearTimeout(entry.timer)
            entry.reject(new Error(reason))
            pending.delete(id)
        }
    }

    return {
        get open(): boolean {
            return socket?.readyState === WebSocket.OPEN
        },

        /** Resolves once the socket is open. Rejects if it cannot be. */
        connect(): Promise<void> {
            return new Promise((resolve, reject) => {
                const next = new WebSocket(opts.endpoint)
                socket = next
                next.addEventListener("open", () => resolve(), { once: true })
                next.addEventListener("error", () => reject(new Error(`could not reach ${opts.endpoint}`)), { once: true })
                next.addEventListener("message", event => {
                    let packet: { type?: string; state?: string; id?: string; ok?: boolean; error?: string; endpoint?: string | null }
                    try {
                        packet = JSON.parse(String(event.data))
                    } catch {
                        return
                    }
                    if (packet.type === "session" && typeof packet.state === "string") opts.onSession(packet.state)
                    if (packet.type === "command-result" && packet.id) {
                        const entry = pending.get(packet.id)
                        if (!entry) return
                        pending.delete(packet.id)
                        clearTimeout(entry.timer)
                        entry.resolve({ ok: packet.ok === true, ...(packet.error ? { error: packet.error } : {}), state: packet.state ?? "", endpoint: packet.endpoint ?? null })
                    }
                })
                next.addEventListener("close", () => {
                    if (socket === next) socket = null
                    fail("the body's bridge closed")
                    opts.onClose()
                }, { once: true })
            })
        },

        /** One effector command. A refusal from the game resolves with `ok: false`; a dead line rejects. */
        command(command: string, params: Record<string, unknown>, timeoutMs: number): Promise<CommandResult> {
            const open = socket
            if (!open || open.readyState !== WebSocket.OPEN) return Promise.reject(new Error("the body's bridge is not connected"))
            const id = randomUUID()
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    pending.delete(id)
                    reject(new Error(`'${command}' got no answer within ${timeoutMs / 1000}s`))
                }, timeoutMs)
                pending.set(id, { resolve: resolve, reject: reject, timer: timer })
                open.send(JSON.stringify({ type: "command", id: id, command: command, ...params }))
            })
        },

        close(): void {
            socket?.close(1000, "lab releasing body")
            socket = null
        },
    }
}

export type ControlT = ReturnType<typeof Control>
