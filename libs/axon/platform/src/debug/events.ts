import type { LogT } from "./log"
import type { RingT } from "./ring"
import type { Event, Fault, Found, Summary, Trouble } from "./types"

export type Filter = {
    /** Events whose type starts with this. */
    type?: string
    system?: string
    component?: string
    entity?: string
    /** Bounds on the tick an event names; an event that names none is left out when either is set. */
    fromTick?: number
    toTick?: number
    /** Bounds on when it happened, epoch ms. */
    fromMs?: number
    toMs?: number
    /** Any further test of an event the caller has — applied before the limit, so it narrows the whole session. */
    passes?: (event: Event) => boolean
    /** Only events after this seq — the `next` of the answer before. */
    after?: number
    limit: number
    /** The last `limit` that match, rather than the first. */
    tail: boolean
    /** Values as recorded, however long. */
    full: boolean
}

/** Arrays and strings longer than these are cut in an answer, unless it is asked for in full. */
const LONGEST = { array: 16, text: 400 }

/**
 * Events — a session's events, filtered, from both places they are kept:
 * the log (what the mind declared, and what happened to it) and the
 * telemetry ring (every tick, run and write, for as far back as it reaches).
 *
 * One order across both: every event carries the session's own `seq`.
 */
export function Events(opts: { log: LogT; ring: RingT }) {
    const log = opts.log
    const ring = opts.ring

    return {
        /** The events that pass `filter`, oldest first, and the seq to ask after for more (null when there are none). */
        query(session: Found, data: string, summary: Summary, filter: Filter): { events: Event[]; next: number | null } {
            const kept: Event[] = []
            let more = false
            const take = (event: Event): boolean => {
                if (!match.passes(event, filter)) return true
                if (filter.tail) {
                    kept.push(event)
                    if (kept.length > filter.limit) kept.shift()
                    return true
                }
                if (kept.length === filter.limit) { more = true; return false }
                kept.push(event)
                return true
            }

            // The log first, then the ring, then put in one order: the ring is the newer and larger half.
            log.scan(session.file, 0, line => {
                const head = log.head(line)
                if (!head || head.type === "session:header") return
                if (filter.type !== undefined && !head.type.startsWith(filter.type)) return
                if (head.ms !== null && filter.toMs !== undefined && head.ms > filter.toMs) return false
                if (head.ms !== null && filter.fromMs !== undefined && head.ms < filter.fromMs) return
                const event = log.parse(line)
                // A torn line is counted by the index, and is not an event.
                return event ? take(event) : undefined
            })
            const fromLog = kept.splice(0)
            const logMore = more
            more = false

            // The last of them are in the newest segments, so a tail reads those first and stops when it has enough.
            const segments = ring.segments(data, session.id)
            const fromRing: Event[] = []
            for (const segment of filter.tail ? segments.reverse() : segments) {
                const known = summary.segments[segment.name]
                if (known && match.outside(known, filter)) continue
                let stopped = false
                for (const event of ring.read(segment.file, "array")) {
                    if (!take(event as Event)) { stopped = true; break }
                }
                if (filter.tail) {
                    fromRing.unshift(...kept.splice(0))
                    if (fromRing.length >= filter.limit) break
                } else if (stopped) break
            }
            if (!filter.tail) fromRing.push(...kept.splice(0))

            const merged = [...fromLog, ...fromRing].sort((a, b) => a.time.seq - b.time.seq)
            const events = filter.tail ? merged.slice(-filter.limit) : merged.slice(0, filter.limit)
            const cut = !filter.tail && (logMore || more || merged.length > filter.limit)
            return { events: filter.full ? events : events.map(event => shorten.value(event) as Event), next: cut && events.length ? events[events.length - 1]!.time.seq : null }
        },

        /** Everything that went wrong, in order: faults from the log and the ring, and each trouble as it opened and closed. */
        wrong(summary: Summary): { faults: Fault[]; troubles: Trouble[]; faultsTotal: number } {
            const segments = Object.values(summary.segments)
            return {
                faults: [...summary.log.faults, ...segments.flatMap(segment => segment.faults)].sort((a, b) => a.seq - b.seq),
                troubles: segments.flatMap(segment => segment.troubles).sort((a, b) => a.at - b.at),
                faultsTotal: summary.log.faultsTotal + segments.reduce((sum, segment) => sum + segment.faultsTotal, 0),
            }
        },
    }
}

export type EventsT = ReturnType<typeof Events>

const match = {
    passes(event: Event, filter: Filter): boolean {
        const data = (event.data ?? {}) as Record<string, unknown>
        if (filter.after !== undefined && event.time.seq <= filter.after) return false
        if (filter.type !== undefined && !event.type.startsWith(filter.type)) return false
        if (filter.system !== undefined && !match.named(data.system, filter.system)) return false
        if (filter.component !== undefined && !match.named(data.component, filter.component)) return false
        if (filter.entity !== undefined && data.entity !== filter.entity) return false
        if (filter.fromMs !== undefined && event.time.ms < filter.fromMs) return false
        if (filter.toMs !== undefined && event.time.ms > filter.toMs) return false
        if (filter.fromTick !== undefined || filter.toTick !== undefined) {
            if (typeof data.tick !== "number") return false
            if (filter.fromTick !== undefined && data.tick < filter.fromTick) return false
            if (filter.toTick !== undefined && data.tick > filter.toTick) return false
        }
        return filter.passes === undefined || filter.passes(event)
    },

    /** A full name, or the end of one. */
    named(value: unknown, wanted: string): boolean {
        return typeof value === "string" && (value === wanted || value.endsWith(`/${wanted}`))
    },

    /** Whether a whole segment lies outside the filter's ticks or times, so it need not be read. */
    outside(segment: { firstMs: number; lastMs: number; firstTick: number; lastTick: number }, filter: Filter): boolean {
        if (filter.fromMs !== undefined && segment.lastMs < filter.fromMs) return true
        if (filter.toMs !== undefined && segment.firstMs > filter.toMs) return true
        if (filter.fromTick !== undefined && segment.lastTick < filter.fromTick) return true
        if (filter.toTick !== undefined && segment.lastTick >= 0 && segment.firstTick > filter.toTick) return true
        return false
    },
}

const shorten = {
    /** A value with its long arrays and strings cut, each saying how long it was. */
    value(value: unknown): unknown {
        if (typeof value === "string") return value.length > LONGEST.text ? `${value.slice(0, LONGEST.text)}… (${value.length} characters)` : value
        if (Array.isArray(value)) {
            if (value.length > LONGEST.array && value.every(entry => typeof entry === "number")) return { cut: `${value.length} numbers`, first: value.slice(0, 4) }
            if (value.length > LONGEST.array) return [...value.slice(0, LONGEST.array).map(shorten.value), { cut: `${value.length - LONGEST.array} more` }]
            return value.map(shorten.value)
        }
        if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, shorten.value(inner)]))
        return value
    },
}
