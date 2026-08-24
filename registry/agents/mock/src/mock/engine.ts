import { Mock } from "@arcforge/engines/providers"
import { extractUserText, type MockTurn } from "@arcforge/engines/mock"
import type { AxonEngineRequest } from "@arcforge/types"
import { commands, renderHelp } from "./commands"

/**
 * The mock agent's engine — a `Mock()` handler that dispatches on a leading
 * slash word.
 *
 * ── Why a handler rather than a reply map ──────────────────────────────────
 *
 * The map form matches a substring and returns a canned reply, which is the
 * right shape for a test that scripts one exchange. It cannot express any of
 * what this agent is for: `/loop 5` takes an argument, and `/log` is only
 * interesting because tick 0 acts and tick 1 reads its own result. Those are
 * programs, so the whole surface is one handler and the commands are the
 * readable list.
 *
 * ── Prose echoes, a bad slash word does not ────────────────────────────────
 *
 * Plain text is echoed, matching bare `Mock()`: the command set is a surface
 * you opt into with a slash, not a language you must learn before the agent
 * will talk to you.
 *
 * A slash word that matches nothing is treated as a typo instead, because it
 * is one — the user has already signalled they wanted a command, and echoing
 * "/mrkdown" back at them answers a question they did not ask.
 */
export function MockCommands() {
    return Mock((req: AxonEngineRequest, ctx): MockTurn => {
        const text = extractUserText(req).trim()
        const { name, arg } = parse(text)

        // No slash at all is conversation, and echoing it matches bare
        // `Mock()` — the familiar behaviour for someone who just typed a
        // sentence. An empty message has nothing to echo, so it gets help.
        if (!name) return text || renderHelp()

        // A slash word that is not a command is a TYPO, not prose. Echoing
        // "/mrkdown" back tells the user nothing; the command list tells
        // them what they meant.
        const command = commands[name]
        if (!command) return `No command \`/${name}\`.\n\n${renderHelp()}`

        return command.turn({ tick: ctx.tick, arg })
    })
}

/**
 * Splits a leading `/word` from the rest of the message.
 *
 * Reads only the FIRST word, and only when it starts with a slash. A message
 * that merely mentions a command ("what does /loop do") is prose, and
 * answering it by running the loop would make the agent unusable for asking
 * questions about itself.
 */
function parse(text: string): { name?: string; arg: string } {
    if (!text.startsWith("/")) return { arg: "" }

    const space = text.search(/\s/)
    const name = (space === -1 ? text : text.slice(0, space)).slice(1).toLowerCase()
    const arg = space === -1 ? "" : text.slice(space).trim()

    return { name, arg }
}
