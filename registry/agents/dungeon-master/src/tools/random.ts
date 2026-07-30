import { faker } from "@faker-js/faker"

/**
 * Fresh random details on demand, drawn from faker. Reach for these any time
 * you need a name, place, or word that shouldn't repeat — a stranger who walks
 * in, a town on the road, a tavern, a spark for an idea. Pulling from here keeps
 * the world from falling back on the same handful of names every game.
 *
 * ```ts
 * random.name()       // "Levi Thorne"
 * random.firstName()  // "Imogen"
 * random.place()      // "Turnerfurt"
 * random.word()       // "lantern"
 * random.animal()     // "wolf"
 * ```
 */
export const random = {
    /** A full first + last name for a character. */
    name(): string {
        return `${faker.person.firstName()} ${faker.person.lastName()}`
    },
    /** Just a first name. */
    firstName(): string {
        return faker.person.firstName()
    },
    /** A place name — a town, city, or settlement. */
    place(): string {
        return faker.location.city()
    },
    /** A single evocative noun, for a spark or a detail. */
    word(): string {
        return faker.word.noun()
    },
    /** A random adjective, e.g. to color a description. */
    adjective(): string {
        return faker.word.adjective()
    },
    /** A kind of animal. */
    animal(): string {
        return faker.animal.type()
    },
}
