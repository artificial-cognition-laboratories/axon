import { bridge } from "../bridge"

/**
 * Discrete acts the agent invokes, as opposed to the continuous control its
 * cognet holds on the input lease.
 *
 * Holding "right" is motor output. Saying something, toggling PvP or choosing
 * a hotbar slot are single events with no duration, so they are commands —
 * same family as joining a server, and they fail with a reason rather than
 * silently doing nothing.
 */

export const TEAMS = ["none", "red", "green", "blue", "yellow", "pink"] as const
export type Team = (typeof TEAMS)[number]

/**
 * Say something in multiplayer chat, as Terry.
 *
 * Throws if not in a world, or if the message is empty or over 500 characters.
 */
export async function say(text: string) {
    const result = await bridge().command("say", { text })
    if (!result.ok) throw new Error(`Could not say that: ${result.error ?? "unknown reason"}`)
    return { said: text }
}

/**
 * Opt in or out of player-versus-player damage.
 *
 * Off by default. While on, Terry can be hurt by, and can hurt, other players
 * on opposing teams.
 */
export async function setPvp(enabled: boolean) {
    const result = await bridge().command("pvp", { enabled })
    if (!result.ok) throw new Error(`Could not set pvp: ${result.error ?? "unknown reason"}`)
    return { pvp: enabled }
}

/**
 * Join a team, or leave one with "none".
 *
 * Teammates cannot hurt each other even with PvP on, so this is the setting
 * that decides whether Terry is dangerous to you.
 */
export async function setTeam(team: Team) {
    const number = TEAMS.indexOf(team)
    if (number < 0) throw new Error(`Unknown team '${team}'. Teams: ${TEAMS.join(", ")}.`)

    const result = await bridge().command("team", { number })
    if (!result.ok) throw new Error(`Could not join team: ${result.error ?? "unknown reason"}`)
    return { team }
}

/**
 * Choose which hotbar slot (0-9) Terry is holding.
 *
 * This is what gives the useItem control its meaning: the motor system presses
 * the button, this decides what the button does.
 */
export async function selectHotbarSlot(slot: number) {
    if (!Number.isInteger(slot) || slot < 0 || slot > 9)
        throw new Error(`Hotbar slot must be an integer 0-9, got ${slot}.`)

    const result = await bridge().command("select-slot", { number: slot })
    if (!result.ok) throw new Error(`Could not select slot: ${result.error ?? "unknown reason"}`)
    return { slot }
}
