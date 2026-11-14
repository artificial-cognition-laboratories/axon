import { err } from "@arcforge/err"
import type { AxonEngineMessage } from "@arcforge/types"

type History = { type: "system" | "user"; text: string } | { type: "model"; response: string[] }

/** Normalize text conversation once, retaining role and order. */
export function Conversation(opts: { messages: readonly AxonEngineMessage[] }) {
    function messages(): Array<{ role: AxonEngineMessage["role"]; content: string }> {
        return opts.messages.map(message => {
            if (typeof message.content === "string") return { role: message.role, content: message.content }
            const content = message.content.map(part => {
                if (part.type !== "text") throw err("MODEL_INPUT_INVALID", { detail: "this local model accepts text only" })
                return part.text
            }).join("\n")
            return { role: message.role, content: content }
        })
    }
    function llama(): History[] {
        const entries = messages()
        if (entries.length === 0) throw err("MODEL_INPUT_INVALID", { detail: "local chat requires a nonempty conversation" })
        const history: History[] = entries.map(message => message.role === "assistant"
            ? { type: "model", response: [message.content] }
            : { type: message.role, text: message.content })
        // Request messages are complete turns. The empty model entry opens
        // a fresh response rather than continuing the previous reply.
        history.push({ type: "model", response: [] })
        return history
    }
    return { messages: messages, llama: llama }
}
