/**
 * Long-polling loop for the Telegram Bot API.
 *
 * Calls getUpdates with a 30s timeout, dispatches each update to registered
 * handlers, then immediately polls again. No webhooks needed — works behind
 * NAT, on localhost, anywhere.
 *
 * Only one poller should run per agent process. Start with `startPolling()`,
 * stop with `stopPolling()`.
 */

import { api } from "./client.js"

export type TelegramMessage = {
    messageId: number
    chatId: number
    userId: number
    username: string | null
    text: string
    /** True if the text starts with a / command */
    isCommand: boolean
}

export type TelegramCallbackQuery = {
    queryId: string
    chatId: number
    userId: number
    messageId: number
    data: string
}

type UpdateHandler = {
    onMessage: (msg: TelegramMessage) => Promise<void>
    onCallback: (query: TelegramCallbackQuery) => Promise<void>
}

let running = false
let offset = 0

export function startPolling(handler: UpdateHandler): void {
    if (running) return
    running = true
    void poll(handler)
}

export function stopPolling(): void {
    running = false
}

async function poll(handler: UpdateHandler): Promise<void> {
    while (running) {
        try {
            const updates = await api<any[]>("getUpdates", {
                offset,
                timeout: 30,
                allowed_updates: ["message", "callback_query"],
            })

            for (const update of updates ?? []) {
                offset = update.update_id + 1
                await dispatch(update, handler)
            }
        } catch (err) {
            // Log and backoff — don't crash the polling loop on transient errors
            console.error("[telegram] poll error:", err instanceof Error ? err.message : err)
            await sleep(5_000)
        }
    }
}

async function dispatch(update: any, handler: UpdateHandler): Promise<void> {
    try {
        if (update.message?.text) {
            const msg = update.message
            await handler.onMessage({
                messageId: msg.message_id,
                chatId: msg.chat.id,
                userId: msg.from?.id ?? 0,
                username: msg.from?.username ?? null,
                text: msg.text,
                isCommand: msg.text.startsWith("/"),
            })
        } else if (update.callback_query) {
            const q = update.callback_query
            await handler.onCallback({
                queryId: q.id,
                chatId: q.message?.chat?.id ?? 0,
                userId: q.from?.id ?? 0,
                messageId: q.message?.message_id ?? 0,
                data: q.data ?? "",
            })
        }
    } catch (err) {
        console.error("[telegram] dispatch error:", err instanceof Error ? err.message : err)
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}
