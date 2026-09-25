import type { Embodiment } from "./lab"
/**
 * The shared handle to the AxonT cable.
 *
 * The transport lives in a server plugin, but tools run in the capsule and are
 * rebuilt on reload. A well-known global symbol is the one contract both sides
 * agree on, so a tool edit never drops the live socket.
 */

export type SessionState = "detached" | "menu" | "joining" | "in-world"

export type Session = {
    state: SessionState
    endpoint: string | null
}

export type BridgeHandle = {
    /** The body this agent occupies right now, or null while it has none. */
    embodiment(): Embodiment | null
    session(): Session
    /** Runs one effector command in the client and resolves with its outcome. */
    command(command: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<CommandResult>
    /** Resolves when the client reaches `state`, or rejects on timeout. */
    awaitState(state: SessionState, timeoutMs: number): Promise<Session>
    /** Observes every session transition. Returns an unsubscribe function. */
    onSession(listener: (session: Session) => void): () => void
}

export type CommandResult = {
    ok: boolean
    error?: string
    state: SessionState
    endpoint: string | null
}

export const BRIDGE = Symbol.for("axon.terraria.bridge")

const host = globalThis as typeof globalThis & { [BRIDGE]?: BridgeHandle }

export function bridge(): BridgeHandle {
    const handle = host[BRIDGE]
    if (!handle)
        throw new Error("The Terraria bridge plugin is not running; the module did not boot.")
    return handle
}

export function publishBridge(handle: BridgeHandle): void {
    host[BRIDGE] = handle
}
