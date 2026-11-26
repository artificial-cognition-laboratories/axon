import { err } from "@arcforge/err"

/**
 * A world address — where an agent plugs in, written as one string.
 *
 *     world://<host>/<lab>/<world>[/<scenario>]?body=<body>&as=<identity>
 *
 * One rule shapes it: **the path is the place, the query is what the arriving
 * agent asks for.** Each path segment narrows the one before it — a lab holds
 * worlds, a world holds scenarios — and a scenario is a place in its own right
 * because it runs on a copy of the world it names. What body to wear and what
 * name to wear it under are properties of this arrival, not of the place, so
 * they are query.
 *
 *     world://localhost/terraverse/kilns               a player's body, in the kilns server
 *     world://localhost/terraverse/kilns/reach-the-door a run: it ends, and reports
 *     world://localhost/terraverse/kilns?as=Terry      worn under a name of its own
 *     world://localhost/terraverse                     whatever terraverse already runs
 *
 * A lab IS a universe: there is no level above it, and the first segment names
 * one directly.
 *
 * The scenario segment is what makes an address a run rather than an open-ended
 * connection — it is the only difference in lifetime, and it is visible in the
 * address rather than hidden in a flag.
 *
 * ── The shorthand ───────────────────────────────────────────────────────────
 *
 * `terraverse`, and `terraverse/player`, are also addresses: the old `AXON_BODY` form,
 * which names a lab and a body but no world. They parse to the same shape with
 * `world: null`, meaning "whatever that lab is already running" — an address
 * that can join a world but never start one. Everything downstream reads one
 * type, and the one that cannot start a world says so where it is used.
 */
export type Connection = {
    /** Where the lab's daemon is. Local only today; a remote host is refused at the parse. */
    host: string
    /** The lab, which is the universe. */
    lab: string
    /** Null for the shorthand form: the lab's already-running world, which this address cannot start. */
    world: string | null
    /** Named: a run on a copy of the world, which ends and reports. Null: an open-ended connection. */
    scenario: string | null
    /** Which of the lab's bodies to wear. Null for a lab whose bodies are all one kind. */
    body: string | null
    /** The name the body goes by in the world. Null: the agent's own, decided where it is worn. */
    identity: string | null
}

/** Every host that means this machine. A lab elsewhere is refused rather than quietly served from here. */
const LOCAL = new Set(["localhost", "127.0.0.1", "::1", "[::1]"])
/**
 * What a path segment may be, once decoded.
 *
 * Spaces are in, because world names have them — Minecraft's `Cave Wars` is
 * an ordinary save, and an address that could not carry it would be an
 * address for some of the worlds. They are percent-encoded on the way out and
 * decoded on the way in, so the string stays a real URL either way. What is
 * refused is a separator or a control character: anything that would change
 * where the segment ENDS.
 */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9 _.-]*$/
/** What the query may carry. Anything else is a typo, and a silently ignored typo is a body nobody wears. */
const ASKED = new Set(["body", "as"])

/**
 * The world address, parsed and written back.
 *
 * A pure pair: text in, a `Connection` out, and the same connection back to
 * text. No lab is contacted and nothing is resolved — whether that world
 * exists is the daemon's answer, given later and loudly.
 */
export const address = {
    /** `text` as a connection, or a thrown reason it is not one. */
    parse(text: string): Connection {
        const said = text.trim()
        if (!said) throw err("WORLD_ADDRESS_INVALID", { detail: "an empty world address — say where to plug in, e.g. world://localhost/terraverse/kilns" })
        return said.includes("://") ? full(said) : short(said)
    },

    /** `connection` written as the canonical address — what is printed back to a person, and a real URL. */
    format(connection: Connection): string {
        const place = [connection.lab, connection.world, connection.scenario]
            .filter(part => part !== null)
            .map(part => encodeURIComponent(part))
            .join("/")
        const asked = new URLSearchParams()
        if (connection.body) asked.set("body", connection.body)
        if (connection.identity) asked.set("as", connection.identity)
        const query = asked.toString()
        return `world://${connection.host}/${place}${query ? `?${query}` : ""}`
    },
}

/** The full form: a `world://` URL, every part of it checked. */
function full(said: string): Connection {
    let url: URL
    try {
        url = new URL(said)
    } catch {
        throw err("WORLD_ADDRESS_INVALID", { detail: `${said} is not a world address — it should read world://<host>/<lab>/<world>[/<scenario>]` })
    }
    if (url.protocol !== "world:") {
        throw err("WORLD_ADDRESS_INVALID", { detail: `${said} speaks ${url.protocol.replace(":", "")}, not world — a world address begins world://` })
    }
    if (!LOCAL.has(url.hostname)) {
        throw err("WORLD_ADDRESS_REMOTE", { detail: `${url.hostname} is not this machine, and a lab elsewhere is not wired yet — use localhost`, context: { host: url.hostname } })
    }

    // `URL` leaves the path percent-encoded; a name is what a person typed.
    const path = url.pathname.split("/").filter(part => part !== "").map(part => decoded(part, said))
    if (path.length < 1 || path.length > 3) {
        throw err("WORLD_ADDRESS_INVALID", { detail: `${said} names ${path.length} places — a world address is <lab>/<world>, a run is <lab>/<world>/<scenario>, and <lab> alone is whatever that lab already runs` })
    }
    for (const part of path) named(part, said)

    for (const key of url.searchParams.keys()) {
        if (!ASKED.has(key)) throw err("WORLD_ADDRESS_INVALID", { detail: `${said} asks for "${key}", which a world address does not carry — only body and as` })
    }
    const body = url.searchParams.get("body")
    const identity = url.searchParams.get("as")
    if (body !== null) named(body, said)

    return {
        host: url.host,
        lab: path[0]!,
        world: path[1] ?? null,
        scenario: path[2] ?? null,
        body: body,
        identity: identity,
    }
}

/** The shorthand: `terraverse`, or `terraverse/player` — a lab and a body, with no world. */
function short(said: string): Connection {
    const parts = said.split("/")
    if (parts.length > 2) {
        throw err("WORLD_ADDRESS_INVALID", { detail: `${said} is neither a lab and a body (terraverse/player) nor a world address (world://localhost/terraverse/kilns)` })
    }
    for (const part of parts) named(part, said)
    return {
        host: "localhost",
        lab: parts[0]!,
        world: null,
        scenario: null,
        body: parts[1] ?? null,
        identity: null,
    }
}

/** One path segment, as it was written. A broken escape is the address's problem, not the lab's. */
function decoded(part: string, said: string): string {
    try {
        return decodeURIComponent(part)
    } catch {
        throw err("WORLD_ADDRESS_INVALID", { detail: `"${part}" in ${said} is not escaped properly — a space is %20` })
    }
}

/** A name a place or a body may go by — refused here rather than sent to a lab to puzzle over. */
function named(part: string, said: string): void {
    if (!SEGMENT.test(part)) {
        throw err("WORLD_ADDRESS_INVALID", { detail: `"${part}" in ${said} is not a name — letters, digits, dots, dashes and underscores, beginning with a letter or digit` })
    }
}
