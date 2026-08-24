/**
 * The Telegram tool surface — the agent's mouth. Only `telegram` is exported:
 * any export from a tools/ file becomes an agent-callable namespace, so the
 * client is a private local.
 *
 * ONE verb. Sending a message is one act, and formatting or attaching a file
 * is a property of that act, not a separate decision worth a tool call.
 * `sendMarkdown`, `sendButtons`, `edit`, `typing` and `sendFile` were five
 * tools for one intention: say this, to them.
 *
 * The address always comes from a stimulus the agent received — the mind
 * reads `channel` off the message it is answering and passes it here. There
 * is deliberately no "reply to the last sender": that is a hidden global that
 * misroutes the moment two people write at once.
 *
 * Tools run in the capsule sandbox, a different process from the module's
 * setup(). Nothing is shared across that boundary, which is why this reads
 * the token from the capsule env rather than receiving a client.
 */

import { readFile } from "node:fs/promises"
import { basename, extname } from "node:path"
import { TelegramClient, type TelegramClientT } from "../telegram/client.js"

export type TelegramAttachment = {
    /** Absolute path to a file on disk. */
    path: string
    /** Optional override for the filename shown in the chat. */
    name?: string
}

export type TelegramSendOpts = {
    /**
     * Files to attach. Telegram carries one document per message, so multiple
     * attachments become multiple messages — the text rides with the first.
     */
    attachments?: TelegramAttachment[]
    /**
     * Set false for literal text. Markdown is the default because agent output
     * is usually prose with code in it, which renders badly unparsed.
     */
    markdown?: boolean
}

let _client: TelegramClientT | null = null

function client(): TelegramClientT {
    if (_client) return _client
    const token = process.env.TELEGRAM_BOT_TOKEN
    if (!token) {
        throw new Error(
            "TELEGRAM_BOT_TOKEN is not set in the capsule environment.\n" +
            "Create a bot with @BotFather and add the token to your agent's .env.",
        )
    }
    _client = TelegramClient({ token })
    return _client
}

export const telegram = {
    /**
     * Send a message to a Telegram chat.
     *
     * `channel` is the address from the stimulus being answered —
     * `"telegram:123456789"` — or a bare chat id.
     *
     * @param channel - Channel address from the stimulus, e.g. "telegram:123456789"
     * @param text - Message body. Markdown by default.
     * @param options - Attachments and formatting
     *
     * Returns a receipt — the chat it went to and the message ids Telegram
     * assigned. A send is a WRITE the agent is waiting on, so it has to come
     * back as evidence it happened: returning void echoed `null` into the
     * capsule result, which reads as failure, and an agent that believes its
     * reply failed sends it again. Five times, in the case that produced this.
     *
     * `fs.write` returning void is fine for the same reason this is not —
     * nothing is waiting to hear whether it landed.
     *
     * @example
     * await telegram.send("telegram:123456789", "Deploy finished — all green.")
     * await telegram.send(channel, "Here's the report.", {
     *     attachments: [{ path: "/tmp/report.pdf" }],
     * })
     */
    async send(
        channel: string,
        text: string,
        options: TelegramSendOpts = {},
    ): Promise<{ ok: true; channel: string; chatId: number; messageIds: number[] }> {
        const chatId = toChatId(channel)
        const parseMode = options.markdown === false ? undefined : "Markdown"
        const attachments = options.attachments ?? []

        if (attachments.length === 0) {
            const sent = await client().call<{ message_id: number }>("sendMessage", {
                chat_id: chatId,
                text,
                ...(parseMode ? { parse_mode: parseMode } : {}),
            })
            return { ok: true, channel, chatId, messageIds: [sent.message_id] }
        }

        // The text becomes the caption of the first document, so the common
        // case — one attachment — is a single message, not a message plus a
        // file.
        const messageIds: number[] = []
        for (let index = 0; index < attachments.length; index++) {
            const attachment = attachments[index]!
            const data = await readFile(attachment.path)
            const name = attachment.name ?? basename(attachment.path)

            const sent = await client().upload<{ message_id: number }>("sendDocument", "document", {
                chat_id: String(chatId),
                ...(index === 0
                    ? { caption: text, ...(parseMode ? { parse_mode: parseMode } : {}) }
                    : {}),
            }, { name, data, mimeType: mimeFor(extname(name)) })
            messageIds.push(sent.message_id)
        }
        return { ok: true, channel, chatId, messageIds }
    },
}

/**
 * Accept either the channel form (`"telegram:123456789"`) or a bare id.
 *
 * Throws on anything else rather than coercing: a NaN chat_id comes back from
 * Telegram as "chat not found", which reads like the chat was deleted and
 * hides the real fault — a malformed address.
 */
function toChatId(channel: string): number {
    const raw = channel.startsWith("telegram:") ? channel.slice("telegram:".length) : channel
    const id = Number(raw)
    if (raw.trim() === "" || !Number.isFinite(id)) {
        throw new Error(
            `Invalid Telegram channel "${channel}" — expected "telegram:<chatId>" or a numeric chat id. ` +
            `Use the channel from the stimulus you are replying to.`,
        )
    }
    return id
}

function mimeFor(ext: string): string {
    const map: Record<string, string> = {
        ".pdf": "application/pdf",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".txt": "text/plain",
        ".md": "text/markdown",
        ".json": "application/json",
        ".csv": "text/csv",
        ".zip": "application/zip",
    }
    return map[ext.toLowerCase()] ?? "application/octet-stream"
}
