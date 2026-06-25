import { api, apiUpload } from "../telegram/client.js"
import { readFileSync } from "node:fs"
import { basename, extname } from "node:path"

/**
 * An inline keyboard button. Tapping it fires a `telegram:button` hook
 * with the `data` field as payload.
 */
export type Button = {
    /** Label shown on the button. */
    label: string
    /** Opaque string payload delivered to the `telegram:button` hook. Max 64 bytes. */
    data: string
}

/**
 * A row of inline keyboard buttons. Buttons in the same row appear side by side.
 */
export type ButtonRow = Button[]

/**
 * A sent message handle — use to edit or delete the message later.
 */
export type SentMessage = {
    messageId: number
    chatId: number
}

export const telegram = {
    /**
     * Send a plain text message to a chat.
     *
     * @example
     * await telegram.send(chatId, "Task complete.")
     */
    async send(chatId: number, text: string): Promise<SentMessage> {
        const msg = await api<any>("sendMessage", { chat_id: chatId, text })
        return { messageId: msg.message_id, chatId: msg.chat.id }
    },

    /**
     * Send a message with Markdown formatting.
     *
     * Supports: **bold**, _italic_, `inline code`, ```code blocks```, [links](url).
     * Telegram uses MarkdownV2 — special characters outside formatting must be escaped.
     * Prefer plain `send()` for unformatted output.
     *
     * @example
     * await telegram.sendMarkdown(chatId, "**3 errors found** in `src/auth.ts`")
     */
    async sendMarkdown(chatId: number, text: string): Promise<SentMessage> {
        const msg = await api<any>("sendMessage", {
            chat_id: chatId,
            text,
            parse_mode: "Markdown",
        })
        return { messageId: msg.message_id, chatId: msg.chat.id }
    },

    /**
     * Send a message with inline keyboard buttons attached.
     *
     * Buttons are arranged in rows. Each button carries a `data` payload
     * delivered to the `telegram:button` hook when tapped. Use for
     * confirmations, selections, and multi-step flows.
     *
     * @example
     * await telegram.sendButtons(chatId, "Which PR should I review?", [
     *     [{ label: "#42 auth fix", data: "review:42" }, { label: "#43 rate limiting", data: "review:43" }],
     *     [{ label: "Skip", data: "review:skip" }],
     * ])
     */
    async sendButtons(chatId: number, text: string, buttons: ButtonRow[]): Promise<SentMessage> {
        const msg = await api<any>("sendMessage", {
            chat_id: chatId,
            text,
            reply_markup: {
                inline_keyboard: buttons.map(row =>
                    row.map(btn => ({ text: btn.label, callback_data: btn.data }))
                ),
            },
        })
        return { messageId: msg.message_id, chatId: msg.chat.id }
    },

    /**
     * Edit a previously sent message in place.
     *
     * Use to simulate streaming — send a placeholder, then keep editing it
     * as the agent produces output. Telegram shows edits live with no flash.
     *
     * @example
     * const msg = await telegram.send(chatId, "Thinking...")
     * // ... agent runs ...
     * await telegram.edit(msg, "Done — 3 issues found.")
     */
    async edit(message: SentMessage, text: string): Promise<void> {
        await api("editMessageText", {
            chat_id: message.chatId,
            message_id: message.messageId,
            text,
        })
    },

    /**
     * Edit a previously sent message with Markdown formatting.
     *
     * @example
     * await telegram.editMarkdown(msg, "**Done** — `src/auth.ts` has 3 errors")
     */
    async editMarkdown(message: SentMessage, text: string): Promise<void> {
        await api("editMessageText", {
            chat_id: message.chatId,
            message_id: message.messageId,
            text,
            parse_mode: "Markdown",
        })
    },

    /**
     * Show a "typing..." indicator in the chat.
     *
     * Lasts ~5 seconds or until the next message is sent. Call before starting
     * a long operation so the user knows the agent is working.
     *
     * @example
     * await telegram.typing(chatId)
     * const result = await longOperation()
     * await telegram.send(chatId, result)
     */
    async typing(chatId: number): Promise<void> {
        await api("sendChatAction", { chat_id: chatId, action: "typing" })
    },

    /**
     * Send a file to a chat.
     *
     * Reads the file from disk and uploads it. Caption is optional.
     * Good for sending logs, diffs, reports, or generated files.
     *
     * @example
     * await telegram.sendFile(chatId, "/tmp/report.pdf", "Here's the analysis.")
     */
    async sendFile(chatId: number, filePath: string, caption?: string): Promise<SentMessage> {
        const data = readFileSync(filePath)
        const name = basename(filePath)
        const mimeType = mimeForExt(extname(filePath))

        const msg = await apiUpload<any>("sendDocument", {
            chat_id: String(chatId),
            ...(caption ? { caption } : {}),
        }, { name, data, mimeType })

        return { messageId: msg.message_id, chatId: msg.chat.id }
    },

    /**
     * Answer a callback query — required after receiving a `telegram:button` hook.
     *
     * Clears the loading spinner on the tapped button. Pass a short `text` to
     * show a toast notification to the user (max 200 chars). Call this promptly —
     * Telegram times out unanswered queries after ~30 seconds.
     *
     * @example
     * axon.hooks.on("telegram:button", async ({ queryId, data, answer }) => {
     *     await answer("Got it, reviewing...")
     * })
     */
    async answerCallback(queryId: string, text?: string): Promise<void> {
        await api("answerCallbackQuery", {
            callback_query_id: queryId,
            ...(text ? { text } : {}),
        })
    },
}

function mimeForExt(ext: string): string {
    const map: Record<string, string> = {
        ".pdf": "application/pdf",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".txt": "text/plain",
        ".md": "text/markdown",
        ".json": "application/json",
        ".zip": "application/zip",
    }
    return map[ext.toLowerCase()] ?? "application/octet-stream"
}
