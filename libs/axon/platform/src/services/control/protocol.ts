/**
 * The control channel's wire vocabulary — the one file both ends agree on.
 *
 * These frames are lifted verbatim from the Fleet webview bridge
 * (`apps/fleet/shared/protocol.ts`), which already proved the shape over
 * postMessage: a call carries the property PATH walked to reach a method,
 * and the receiver resolves that path against whatever handle it chose to
 * expose. Adding a verb to either side never touches this file — only
 * domain code changes. That property is why the same frames now serve a
 * second transport instead of a second vocabulary being invented for it.
 *
 * The channel is symmetric by construction. There is no "client frame" and
 * "server frame": both ends send calls and both ends answer them, because
 * the requirement is a TUI that drives the editor AND an editor that drives
 * the TUI. Direction is a property of who holds which handle, not of the
 * protocol.
 */

/** The property path walked to reach a method on the peer's exposed handle. */
export type RpcPath = string[]

export type RpcCall = { type: "rpc.call"; id: string; path: RpcPath; args: unknown[] }

export type RpcResult =
    | { type: "rpc.result"; id: string; ok: true; value: unknown }
    | { type: "rpc.result"; id: string; ok: false; error: string }

/**
 * Subscriptions — the counterpart for live streams (a session tail, the
 * fleet list) that are not one request and one response. The resolved
 * method must accept a listener and return a teardown function, which is
 * the shape every platform leaf's `.watch()` already follows.
 */
export type RpcSubscribe = { type: "rpc.subscribe"; id: string; path: RpcPath; args: unknown[] }
export type RpcUnsubscribe = { type: "rpc.unsubscribe"; id: string }
export type RpcEvent = { type: "rpc.event"; id: string; value: unknown }

/** Every frame that can cross the socket, in either direction. */
export type ControlFrame = RpcCall | RpcResult | RpcSubscribe | RpcUnsubscribe | RpcEvent

/**
 * The handshake. Sent as the first frame by the dialling side, before any
 * call. The token is read from the instance record, which lives in a 0700
 * directory — the file mode guards the secret, the token guards the socket.
 *
 * A listening port is reachable by any local process regardless of file
 * mode, which is precisely why this exists and why the file-based design
 * this replaced did not need it.
 */
export type ControlHello = { type: "control.hello"; token: string; peer: ControlPeer }

/** Accepted. Carries what the peer is, so each side knows what it may call. */
export type ControlWelcome = { type: "control.welcome"; peer: ControlPeer }

export type ControlPeer = "tui" | "editor"

export type ControlHandshake = ControlHello | ControlWelcome

export function isControlFrame(value: unknown): value is ControlFrame {
    if (typeof value !== "object" || value === null) return false
    const type = (value as { type?: unknown }).type
    return (
        type === "rpc.call" ||
        type === "rpc.result" ||
        type === "rpc.subscribe" ||
        type === "rpc.unsubscribe" ||
        type === "rpc.event"
    )
}

/**
 * What the TUI exposes to the editor, and what the editor exposes to the
 * TUI. Declared here rather than inferred from either implementation
 * because this is a cross-process seam: both sides compile against it, and
 * a method appearing on one end that the other cannot call is a bug the
 * type system should catch rather than a runtime "path not found".
 *
 * These are the v1 surfaces — deliberately small. The point of the first
 * iteration is to prove the channel end to end with one real verb in each
 * direction, not to guess the full API before either side has driven it.
 */

/** Called BY the tui, implemented BY the editor extension. */
export type EditorSurface = {
    /**
     * Bring the Axon console panel forward, optionally landing on a
     * specific instance and tab. This is the verb that motivated the whole
     * channel: the agent decides something is worth watching and puts it
     * in front of the human.
     */
    focus(target: { sessionId?: string; tab?: string }): Promise<void>
    /** Open an absolute path in a real editor tab. A directory reveals in the Explorer. */
    open(path: string, options?: { line?: number; beside?: boolean }): Promise<void>

    /**
     * Open one of the agent's runtime panes as an editor buffer, pinned to
     * a run — the editor's own "pop out" gesture, invoked from the TUI.
     *
     * `source` is a live instance id or a session .jsonl path, the same two
     * things every log-reading verb accepts, so a finished run and a
     * running one open identically.
     */
    buffer(kind: "events" | "trace" | "engine" | "logs", source: string): Promise<void>

    /**
     * How good a target this window is, and how recently it was focused.
     *
     * Windows are NOT interchangeable: each has different folders open, so
     * only some can act meaningfully on a given path. This is how the TUI
     * routes without guessing — it asks every attached editor and takes
     * the best answer, rather than tracking which window is "current" from
     * the outside, where that truth does not live.
     *
     * `path` null means "not about anything in particular", and only
     * recency ranks.
     */
    claim(path: string | null): Promise<{ contains: boolean; focusedAt: number }>
}

/**
 * One capsule execution's outcome, flattened for the wire.
 *
 * A structural copy of the kernel's AxonRunResult minus `scope` (bindings
 * are only meaningful to a caller rendering a template, which no editor
 * does) — declared here rather than imported so this file stays the one
 * thing both processes agree on, with no dependency on kernel internals.
 */
export type CapsuleRunOutcome = {
    ok: boolean
    value?: unknown
    stdout: string[]
    error?: { kind: "timeout" | "interrupt" | "exception"; message: string }
}

/** Called BY the editor extension, implemented BY the tui. */
export type TuiSurface = {
    /** Send a message to the focused agent, as if typed into the composer. */
    send(content: string): Promise<void>
    /** Interrupt the focused agent's current run. */
    interrupt(): Promise<void>

    /**
     * Execute TypeScript in one agent's capsule — the developer backdoor
     * behind Fleet's capsule input.
     *
     * PROVENANCE, NOT PRIVILEGE. This is the same verb the agent's own
     * reasoning uses, through the same kernel and the same policy gate: a
     * developer cannot reach anything the agent could not, and a denied
     * call is denied here identically. What differs is that the command is
     * stamped `origin: "host"` so the session log never claims the agent
     * did it.
     *
     * Addressed by sessionId rather than run against "the focused agent",
     * unlike send/interrupt: those are conversation gestures aimed at
     * whatever the human is looking at, while this one names the machine
     * whose global scope it is about to mutate. Picking the wrong one
     * silently is not an acceptable failure mode for code execution.
     */
    capsule(sessionId: string, code: string): Promise<CapsuleRunOutcome>

    /**
     * Bring one agent's conversation forward in this TUI.
     *
     * Any TUI can view any live instance by switching, so this needs no
     * routing on the caller's side beyond picking a TUI — which is what
     * `lastActiveAt` below is for.
     */
    focus(sessionId: string): Promise<void>

    /**
     * When this TUI last had human input, epoch ms.
     *
     * The counterpart to EditorSurface.claim, and the same principle: the
     * caller cannot see which terminal has focus (VS Code exposes the
     * terminal, not the process inside it), so it asks each TUI about
     * itself instead of inferring from the outside.
     */
    lastActiveAt(): Promise<number>
}
