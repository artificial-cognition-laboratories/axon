import { TelegramClient } from "./src/telegram/client"
import { TelegramPoller } from "./src/telegram/poller"

/**
 * Telegram — a sense organ for the agent.
 *
 * Inbound messages become text stimuli on channel `telegram:<chatId>`,
 * exactly like text typed at the terminal — which arrives on `user`. AIR
 * renders that channel onto the turn, so the brain sees WHERE each message
 * came from and can hold two conversations at once without confusing them.
 *
 * Outbound is the `telegram.send` tool, which the brain calls deliberately
 * with the address it read off the stimulus it is answering. Deliberately a
 * tool and not a direct output: a reply needs a target, and an output that
 * carried one would make every emission a routing decision.
 *
 * There are no hooks here. An earlier version emitted `telegram:message` and
 * a plugin answered it with its own `axon.request()`, which spawned an
 * isolated wake per message and bypassed the scheduler — the agent had no
 * continuity across its own conversation. Sensing through `stim` puts
 * Telegram on the same footing as every other channel: one session, one
 * mind, many senses.
 */
export default defineModule({
    env: {
        TELEGRAM_BOT_TOKEN: {
            required: true,
            description: "Bot token from @BotFather on Telegram.",
        },
    },

    options: {
        chatIds: {
            type: "string" as const,
            required: false,
            description:
                "Comma-separated chat IDs to listen to. Leave empty to hear every chat the bot is in. " +
                "This is a wiring choice (which lines are connected), not a trust decision — the sender " +
                "travels with each message so the agent can judge it. Find your ID via @userinfobot.",
        },
    },

    async setup({ axon, options }) {
        // Absent token DEGRADES; it does not abort the boot. `env.require`
        // throws, and a throw in setup() takes the whole agent down — right
        // for a broken module, wrong for one that is merely not connected
        // yet. See the same reasoning in @axon/discord.
        const token = axon.env.get("TELEGRAM_BOT_TOKEN")
        if (!token) {
            await axon.warn(
                "TELEGRAM_BOT_TOKEN is not set — Telegram is installed but not connected. Add the token from @BotFather to your agent's .env.",
            )
            return
        }

        const client = TelegramClient({ token })

        const listening = (options.chatIds ?? "")
            .split(",")
            .map(id => id.trim())
            .filter(Boolean)

        const poller = TelegramPoller({
            client,
            async onUpdate(msg) {
                if (listening.length > 0 && !listening.includes(String(msg.chatId))) return

                const channel = `telegram:${msg.chatId}`

                // The channel rides the envelope alone — AIR renders it as
                // `channel="telegram:<chatId>"` on the turn, which is the
                // return address the brain hands to telegram.send.
                //
                // It used to be repeated inside the content, because the
                // renderer dropped it and a message with no return address
                // cannot be answered. That prefix is retired: routing is
                // metadata about the turn, and in the content the model read
                // it as something a human typed and echoed it back.
                //
                // The sender stays in the content deliberately. Who is
                // speaking is something the mind should weigh — including
                // whether to trust them — while the channel is pure routing.
                await axon.stim("cognet:stimulus:text", {
                    channel,
                    content: `${msg.from}: ${msg.text}`,
                })
            },
        })

        poller.start()

        axon.onDispose(async () => {
            await poller.stop()
        })
    },
})
