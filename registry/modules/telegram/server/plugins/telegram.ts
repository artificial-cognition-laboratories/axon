/**
 * Example Telegram plugin.
 *
 * Copy this into your agent's server/plugins/ directory and adapt it.
 * This is the wiring layer — it subscribes to Telegram hooks and decides
 * what to do with each incoming message or button tap.
 */

export default defineAxonPlugin(async (axon) => {
    axon.hooks.on("telegram:message", async ({ text, chatId, username, reply, replyWithButtons }) => {
        // Load your agent's prompt with the incoming message
        const prompt = await axon.prompt("telegram/message", { text, username })
        const result = await axon.request({ prompt })
        await reply(result.text)
    })

    axon.hooks.on("telegram:command", async ({ command, args, chatId, reply }) => {
        // Handle slash commands — e.g. /review 42
        // Adapt or remove commands your agent doesn't need
        switch (command) {
            case "start":
                await reply("Agent online. Send me a message.")
                break
            case "status":
                await reply("Running.")
                break
            default:
                await reply(`Unknown command: /${command}`)
        }
    })

    axon.hooks.on("telegram:button", async ({ queryId, data, chatId, answer, reply }) => {
        // User tapped an inline keyboard button
        // `data` is the payload set in telegram.sendButtons()
        await answer()  // clear the loading spinner — always call this first
        await reply(`You chose: ${data}`)
    })
})
