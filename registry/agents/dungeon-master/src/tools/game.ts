import { faker } from "@faker-js/faker"

const pick = <T>(a: T[]): T => a[Math.floor(Math.random() * a.length)]!

export const game = {
    /**
     * Roll a fresh set of random seeds for the opening of a NEW adventure.
     * Call this once, at the very start of a game, before you offer the player
     * worlds or a hero. The seeds are deliberately incoherent raw material —
     * their only job is to push each game somewhere different so no two ever
     * open the same way. Take inspiration from them, bend them, blend them, or
     * drop the ones that don't fit. If the player pitches their own idea, follow
     * that instead.
     *
     * ```ts
     * const seed = game.setup()
     * // => { setting, tone, hook, name, place, wildcard }
     * ```
     */
    setup(): {
        setting: string
        tone: string
        hook: string
        name: string
        place: string
        wildcard: string
    } {
        const settings = [
            "a rain-soaked noir city of thieves and secrets",
            "a haunted frontier village on the edge of a dark wood",
            "a sky-pirate port above the clouds",
            "a sunken market-kingdom lit by drowned lanterns",
            "a clockwork cathedral-state where faith is machinery",
            "an ashfall mining colony clinging to a dead volcano",
            "a desert caravan road haunted by mirages",
            "a fae-touched winter forest that rearranges itself",
            "a plague-quarantined island with one way off",
            "a floating night-market that appears only at the new moon",
        ]
        const tones = [
            "paranoid and tense",
            "melancholy and haunted",
            "reckless and swashbuckling",
            "hopeful against long odds",
            "simmering with old revenge",
            "weary but stubborn",
            "darkly comic",
            "eerie and dreamlike",
        ]
        const hooks = [
            "a debt comes due tonight",
            "someone you buried is back",
            "you're carrying something you shouldn't be",
            "a face from your past needs a dangerous favor",
            "the map you trusted was a lie",
            "you're being hunted and don't know why",
            "the person who hired you has vanished",
            "you woke somewhere you don't remember arriving",
        ]
        const surnames = ["Crowe", "Vane", "Ash", "Quill", "Marsh", "Vex", "Thorne", "Grim", "Rook", "Sable"]

        return {
            setting: pick(settings),
            tone: pick(tones),
            hook: pick(hooks),
            name: `${faker.person.firstName()} ${pick(surnames)}`,
            place: faker.location.city(),
            wildcard: `${faker.word.adjective()} ${faker.word.noun()}`,
        }
    },
}
