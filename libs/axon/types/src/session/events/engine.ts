import type { AxonEngineResponse } from "../../engine"
import type { AxonError } from "../../error"

/**
 * The engine wire contract — what AxonEngine.stream() yields and what
 * kernel.stream() hands a cognet.
 *
 * EVERY EVENT HERE IS A FINISHED MECHANISM, NOT A DECISION. The kernel owns
 * the output half of the model service: parsing AIR, running the script,
 * rendering the template against its bindings, enforcing a declared output
 * shape, retrying a malformed response. A cognet receives what the model
 * PRODUCED, never machinery it has to finish itself.
 *
 * What the kernel never decides is whether any of it reaches the world.
 * These are engine:* — the call's content — and emitting is still the
 * cognet's own act through output(). A brain may call an engine to classify
 * a stimulus or judge its own stop condition, and neither is the agent
 * speaking; the kernel cannot tell those apart from a reply, because which
 * is which is a cognitive fact. So it hands back what happened and the
 * cognet routes it.
 *
 * The vocabulary is deliberately small, and named for DATA rather than for
 * the tag that produced it. Every model response reduces to the same two
 * things: a structure it produced, and optionally the computation it ran to
 * get there. `<text>` is a template with lang="md" and no script; a JSON
 * response is lang="json". So there is one spoken event and one action event,
 * whatever protocol was in force.
 *
 * Reasoning/"thinking" tokens are dropped at the adapter boundary and never
 * reach this wire — thinking was never a data kind, it was one inference
 * pipeline's internal stage.
 */
export type AxonEngineEvent =
    /** The call began. The bracket's open half — a consumer showing "thinking" starts here rather than inferring from the first token. */
    | { type: "engine:start" }

    /**
     * The agent spoke — already interpolated, exactly as a user reads it.
     * Never unrendered template source and never a raw brace.
     *
     * `lang` is the structure the model produced ("md" prose, "json" for a
     * declared output shape), so a consumer can tell a message from a value
     * without knowing which protocol was rendered.
     *
     * `chunk` carries the AxonChunk correlation group while streaming; a
     * complete one-shot block has none. NOTE these are chunks of RENDERED
     * output, so they no longer correspond 1:1 to model tokens — one delta
     * can emit nothing (buffered mid-interpolation) or a great deal (a large
     * interpolated value).
     */
    | {
        type: "engine:text"
        content: string
        lang: "md" | "json"
        chunk?: { of: string; final?: boolean }
    }

    /**
     * The model ran code. Reported for the record — the kernel already
     * executed it and committed the result, so a cognet reads this to know
     * what happened, never to act on it.
     */
    | { type: "engine:script"; id: string; content: string }

    /**
     * The call could not produce a usable response — a malformed reply the
     * model failed to correct within its retries, or a declared output shape
     * it never satisfied. Terminal for this call: no `engine:done` follows.
     */
    | { type: "engine:failure"; error: AxonError }

    /**
     * The call ended. Exactly once per successful call, carrying the
     * authoritative response and billing meta.
     *
     * The booleans are SIGNALS, not decisions — reductions over what this
     * call produced, from which a loop derives its own stop condition. The
     * kernel never acts on them and deliberately does not decide whether a
     * turn is over: that is the one thing a loop is for.
     *
     * `yielded` is the model's own <done/>, and it is here under protest.
     * Whether a turn is over is a SEMANTIC question — "I see the issue" and
     * "the fix is deployed" are structurally identical, same block and no
     * script — so no reduction over what a response DID can separate a
     * progress report from a final answer. Deriving it structurally ends a
     * long run the first time the model narrates between actions.
     *
     * So the model is asked, which works consistently enough. It stays a
     * SIGNAL: the kernel never acts on it, and a loop weighs it against the
     * structural facts beside it. Replacing it needs something that can judge
     * the situation rather than the response.
     */
    | {
        type: "engine:done"
        response: AxonEngineResponse
        /** The agent produced user-facing output this call. */
        spoke: boolean
        /** The model emitted a script this call — code it has not yet seen the result of. */
        acted: boolean
        /** The model emitted <done/> — its own claim that it is handing control back. */
        yielded: boolean
    }
