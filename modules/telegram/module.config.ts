import { startPolling, stopPolling } from "./src/telegram/poller"
import { resetClient } from "./src/telegram/client"
import { isAllowed } from "./src/telegram/allowlist"
import { telegram } from "./src/tools/telegram"

export default defineModule({
    name: "telegram",
    description: "Telegram bot integration — receive messages and button taps via long-polling, send replies, markdown, inline keyboards, files, and typing indicators. Requires TELEGRAM_BOT_TOKEN. Set TELEGRAM_ALLOWED_USERS to restrict access to specific user IDs.",
    public: true,

    env: {
        TELEGRAM_BOT_TOKEN: {
            required: true,
            description: "Bot token from @BotFather on Telegram.",
        },
        TELEGRAM_ALLOWED_USERS: {
            required: false,
            description: "Comma-separated Telegram user IDs allowed to interact with the agent. If unset, all users are allowed. Find your ID via @userinfobot.",
        },
    },

    emits: {
        "telegram:message": {} as {
            text: string
            chatId: number
            userId: number
            username: string | null
            messageId: number
            /** Send a plain text reply to this message. */
            reply: (text: string) => Promise<void>
            /** Send a markdown reply to this message. */
            replyMarkdown: (text: string) => Promise<void>
            /** Send a reply with inline keyboard buttons. */
            replyWithButtons: (text: string, buttons: import("./src/tools/telegram").ButtonRow[]) => Promise<void>
        },
        "telegram:command": {} as {
            /** Command name without the leading slash. e.g. "review" for /review */
            command: string
            /** Arguments after the command. e.g. ["42"] for /review 42 */
            args: string[]
            chatId: number
            userId: number
            username: string | null
            reply: (text: string) => Promise<void>
            replyMarkdown: (text: string) => Promise<void>
            replyWithButtons: (text: string, buttons: import("./src/tools/telegram").ButtonRow[]) => Promise<void>
        },
        "telegram:button": {} as {
            /** The callback_data payload set when the button was created. */
            data: string
            queryId: string
            chatId: number
            userId: number
            messageId: number
            /** Dismiss the loading spinner on the button. Always call this. Optional toast text (max 200 chars). */
            answer: (text?: string) => Promise<void>
            reply: (text: string) => Promise<void>
        },
    },

    async setup({ axon }) {
        // Boot the long-polling loop after all plugins are registered
        axon.hook("server:ready", () => {
            startPolling({
                async onMessage(msg) {
                    if (!isAllowed(msg.userId)) return

                    const makeReply = (chatId: number) => ({
                        reply: (text: string) => telegram.send(chatId, text).then(() => { }),
                        replyMarkdown: (text: string) => telegram.sendMarkdown(chatId, text).then(() => { }),
                        replyWithButtons: (text: string, buttons: import("./src/tools/telegram").ButtonRow[]) =>
                            telegram.sendButtons(chatId, text, buttons).then(() => { }),
                    })

                    if (msg.isCommand) {
                        const [rawCmd, ...args] = msg.text.slice(1).split(/\s+/)
                        const command = rawCmd.split("@")[0]  // strip @botname suffix
                        await axon.callHook("telegram:command", {
                            command,
                            args,
                            chatId: msg.chatId,
                            userId: msg.userId,
                            username: msg.username,
                            messageId: msg.messageId,
                            ...makeReply(msg.chatId),
                        })
                    } else {
                        await axon.callHook("telegram:message", {
                            text: msg.text,
                            chatId: msg.chatId,
                            userId: msg.userId,
                            username: msg.username,
                            messageId: msg.messageId,
                            ...makeReply(msg.chatId),
                        })
                    }
                },

                async onCallback(query) {
                    if (!isAllowed(query.userId)) return

                    await axon.callHook("telegram:button", {
                        data: query.data,
                        queryId: query.queryId,
                        chatId: query.chatId,
                        userId: query.userId,
                        messageId: query.messageId,
                        answer: (text?: string) => telegram.answerCallback(query.queryId, text),
                        reply: (text: string) => telegram.send(query.chatId, text).then(() => { }),
                    })
                },
            })
        })

        axon.hook("axon:agent:shutdown", () => {
            stopPolling()
            resetClient()
        })
    },
})
