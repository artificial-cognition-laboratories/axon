/**
 * Long-polling loop for the Telegram Bot API.
 *
 * Owns one concern: producing inbound updates. Calls getUpdates with a long
 * timeout, hands each update to `onUpdate`, and immediately polls again. No
 * webhook, so no public URL — works behind NAT, on localhost, anywhere
 * outbound HTTPS is allowed.
 *
 * Offset is per-instance state, not module-global: two agents in one process
 * poll independently rather than silently consuming each other's updates.
 */

import type { TelegramClientT } from "./client.js"

/** One inbound text message, flattened out of the Bot API's update shape. */
export type TelegramInbound = {
    chatId: number
    userId: number
    /** Sender's @username, or their display name when no username is set. */
    from: string
    text: string
}

export type TelegramPollerOpts = {
    client: TelegramClientT
    onUpdate: (msg: TelegramInbound) => Promise<void>
}

export type TelegramPollerT = ReturnType<typeof TelegramPoller>

/** Long-poll timeout, seconds. Telegram holds the request open this long. */
const POLL_TIMEOUT_S = 30

/** Backoff after a failed poll, so a persistent outage doesn't spin. */
const BACKOFF_MS = 5_000

export function TelegramPoller(opts: TelegramPollerOpts) {
    const { client, onUpdate } = opts

    let offset = 0
    let running = false
    let abort: AbortController | null = null
    let loop: Promise<void> | null = null

    async function poll(): Promise<void> {
        while (running) {
            try {
                const updates = await client.call<TelegramUpdate[]>("getUpdates", {
                    offset,
                    timeout: POLL_TIMEOUT_S,
                    allowed_updates: ["message"],
                }, { signal: abort?.signal })

                for (const update of updates ?? []) {
                    // Advance past this update BEFORE handling it. Telegram
                    // redelivers anything below the offset, so advancing after
                    // a handler that throws would replay the same message
                    // forever.
                    offset = update.update_id + 1

                    const inbound = toInbound(update)
                    if (!inbound) continue

                    try {
                        await onUpdate(inbound)
                    } catch (cause) {
                        // Isolated per update: one bad message must not kill
                        // the agent's hearing. Loud, never silent.
                        console.error("[telegram] failed to deliver update:", cause)
                    }
                }
            } catch (cause) {
                // stop() aborts the in-flight request — an expected shutdown,
                // not a fault.
                if (!running) return
                console.error("[telegram] poll failed:", cause instanceof Error ? cause.message : cause)
                await sleep(BACKOFF_MS)
            }
        }
    }

    return {
        start(): void {
            if (running) return
            running = true
            abort = new AbortController()
            loop = poll()
        },

        /** Stop polling and wait for the in-flight request to unwind. */
        async stop(): Promise<void> {
            if (!running) return
            running = false
            abort?.abort()
            await loop?.catch(() => { })
            abort = null
            loop = null
        },
    }
}

/**
 * Narrow an update to the one kind this module senses: a text message.
 *
 * Everything else (edits, joins, photos, callback queries) is not yet part of
 * the agent's sense surface and is dropped here rather than half-modelled.
 */
function toInbound(update: TelegramUpdate): TelegramInbound | null {
    const msg = update.message
    if (!msg?.text) return null

    const from = msg.from?.username
        ?? [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ")
        ?? null

    return {
        chatId: msg.chat.id,
        userId: msg.from?.id ?? 0,
        from: from || "unknown",
        text: msg.text,
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

type TelegramUpdate = {
    update_id: number
    message?: {
        message_id: number
        text?: string
        chat: { id: number }
        from?: { id: number; username?: string; first_name?: string; last_name?: string }
    }
}
