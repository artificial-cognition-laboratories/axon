import type { Picture } from "./media"

/**
 * A conversation in, the next reply out — whole, or streamed as it is written.
 * Raw: it knows nothing of how a mind renders its context or reads a reply.
 */
export interface Chat {
    describe(): {
        /** How many tokens a conversation and its reply may hold together. */
        context: u32
        /** Whether a message may hold pictures. */
        pictures: boolean
        /** How many conversations it answers at once before the rest wait. */
        slots: u32
    }

    /** The reply, once it is written. */
    request(conversation: Conversation): Promise<Reply>

    /** The reply, as it is written. */
    stream(conversation: Conversation): AsyncIterable<Written>
}

export interface Conversation {
    /** What the model is, and how it answers. */
    system?: string
    messages: Message[]
    /** The most tokens the reply may hold. */
    limit?: u32
}

/** One turn. `role` is "user" or "assistant". */
export interface Message {
    role: string
    text: string
    pictures?: Picture[]
}

export interface Reply {
    text: string
    /** Why it stopped: "done" — it finished; "limit" — it ran out of tokens. */
    stop: string
    /** What it cost in tokens — absent when the provider does not say, never guessed. */
    usage?: Usage
}

/** One piece of a reply as it is written. The last has `stop` and `usage`. */
export interface Written {
    text: string
    stop?: string
    usage?: Usage
}

export interface Usage {
    input: u32
    output: u32
}
