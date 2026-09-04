import type { AxonBlueprint } from "./blueprint"
import type { AxonEntry } from "./session"
import type { AxonStimulusEntry } from "./session/events/stdio/stimuli"

/**
 * A handle to ONE running agent, wherever it runs.
 *
 * ── Why one type for three transports ───────────────────────────────────────
 *
 * An agent may be a process this daemon supervises, a process on another
 * machine's daemon, or a deployment reached over HTTPS. Those differ in how
 * bytes move and in nothing else that a consumer should have to know.
 *
 * Before this, they differed in TYPE: a local agent returned an object graph
 * with a live session, a live bus and a `select()` method, while a remote one
 * returned a proxy. Every surface written against the local shape was silently
 * unusable against the remote one — which is why the Fleet extension can list
 * running agents and cannot speak to them, and why "debug an agent on my other
 * machine" had no path at all.
 *
 * The object graph was the anomaly, not the proxy. A handle whose verbs are
 * async and fallible is the honest description of talking to a process you are
 * not inside; the local shortcut only looked simpler because it hid a
 * boundary that was always there.
 *
 * ── Stimulus is the way in ──────────────────────────────────────────────────
 *
 * Every input is an `AxonStimulusEntry`. A prompt is not a separate concept —
 * it is `cognet:stimulus:text`, and a surface that took a bare string would be
 * inventing a second door into the same brain. Convenience over that belongs
 * in a helper, never in the contract.
 */
export type AxonAgentHandle = {
    /** This agent's session id — its identity everywhere in Axon. */
    readonly sessionId: string

    /**
     * Deliver a stimulus. Resolves on ADMISSION, never on completion.
     *
     * A continuous cognet is ticked by its own plugin and wakes whether or not
     * the last wake finished; resolving on completion would serialise that
     * overlap and turn a mind under a clock into a queue. `admitted: false` is
     * the mind declining a second conversation — an answer, not a failure.
     */
    stimulus(entry: AxonStimulusEntry): Promise<{ admitted: boolean }>

    /**
     * Add a message to a wake that is ALREADY running.
     *
     * The third delivery verb, for the case the other two answer badly: a user
     * typing while the agent works. `stimulus` asks to START a conversation
     * and is refused mid-wake; `request` waits for the whole agent loop. This
     * is neither — the message joins the conversation in flight and the cognet
     * folds it into its next turn, because a loop re-reads the session log
     * every pass.
     *
     * No verdict comes back: the entry is durable either way, and a wake that
     * is not running gets started by the scheduler's own subscription. So a
     * caller racing the end of a wake never has to know which side it landed.
     */
    ingest(entry: AxonStimulusEntry): Promise<void>

    /**
     * Deliver a stimulus and wait for the wake it caused to SETTLE.
     *
     * The completion counterpart to `stimulus`, for an interactive caller who
     * needs to know when the reply is finished. A UI rendering a spinner
     * forever because nothing said "done" is broken in a way admission cannot
     * fix.
     */
    request(entry: AxonStimulusEntry): Promise<{ ok: boolean; interrupted?: boolean }>

    /**
     * Deliver a stimulus and iterate what it produces.
     *
     * The streaming form, and what a surface renders from. `interrupt` aborts
     * the run rather than merely stopping the iteration — a consumer that
     * walked away must not leave a wake burning tokens.
     */
    stream(entry: AxonStimulusEntry): { stream: AsyncGenerator<AxonEntry, void, undefined>; interrupt(): void }

    /**
     * Abort the active wake.
     *
     * Out-of-band, which is why the link has two channels: an interrupt must
     * land WHILE inference is streaming, and behind the same queue it would
     * wait on exactly the traffic it exists to stop.
     */
    interrupt(reason: "user" | "shutdown"): Promise<void>

    /** Hot reload: a re-normalised blueprint replaces the live one. */
    update(blueprint: AxonBlueprint): Promise<void>

    /** Drain and exit. */
    shutdown(): Promise<void>

    /**
     * The agent's log, as this consumer can see it.
     *
     * MIRRORED for every transport, including one in the same process. The
     * local case genuinely holds the real session and could expose it — and
     * that asymmetry is precisely what let surfaces become accidentally
     * local-only. One shape everywhere costs the local case some rebuilt state
     * and buys every surface working against any agent.
     */
    readonly session: AxonMirroredSession

    /**
     * Rebind a role to a different model.
     *
     * A VERB rather than an `engines` object, because the object it replaced
     * carried a `select()` closure that only exists supervisor-side. A method
     * crosses a wire; a closure does not.
     */
    selectModel(model: string): Promise<void>
}

/**
 * The read surface of an agent's log.
 *
 * Modelled on `MirroredSession`, which already solved this for deployments —
 * the accumulated view plus a subscription that replays from a cursor and
 * survives reconnection. A flatter "subscribe(handler)" was the obvious first
 * shape and would have thrown away the two facts a consumer actually needs:
 * when replay ends and live begins, and when the agent behind the URL turns
 * out to be a DIFFERENT session because it restarted.
 */
export type AxonMirroredSession = {
    /** The conversation — what a UI renders. */
    readonly entries: readonly AxonEntry[]
    /** Everything committed, entries included. */
    readonly log: readonly unknown[]
    /** Machine-body events: boot, build, kernel spans. */
    readonly kernelLog: readonly unknown[]
    /**
     * How far this mirror has read. Null before the first event.
     *
     * Exposed because a resume is only meaningful against the session the
     * cursor came from — see `onReset`.
     */
    readonly cursor: number | null

    /** Follow the agent. Returns an unsubscribe. */
    subscribe(handlers: AxonSessionHandlers): () => void
}

/** What a subscriber is told. Every field optional — a consumer takes what it needs. */
export type AxonSessionHandlers = {
    /** Each newly absorbed event, in order. */
    onEvent?: (event: { type: string } & Record<string, unknown>) => void
    /** Replay is done; everything after this is live. */
    onLive?: (cursor: number | null) => void
    /** The stream ended cleanly — the agent shut down. */
    onClose?: () => void
    /**
     * The agent is a DIFFERENT session than the one mirrored — it restarted.
     *
     * The mirror has already dropped the old history, so a consumer rendering
     * from it must re-read rather than append to what it had. Without this a
     * restart shows one conversation with two agents' turns interleaved.
     */
    onReset?: (sessionId: string) => void
}

/**
 * The authoring verbs, available only where the agent's project is.
 *
 * Deliberately NOT on `AxonAgentHandle`. `prompts` and `run` read and execute
 * source that lives beside the agent on disk — a deployment has no project to
 * read, and a daemon on another machine has one this caller cannot see. A
 * transport that cannot do them says so by not implementing this, rather than
 * by throwing at a verb the type promised.
 */
export type AxonAuthoringHandle = {
    /** The prompts this agent declares, rendered. */
    prompts(): Promise<unknown>
    /** Execute code in the agent's own scope. */
    run(code: string): Promise<unknown>
}
