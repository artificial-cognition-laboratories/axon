import { describe, expect, test } from "bun:test"
import { ZERO_PREFLIGHT } from "../src/preflight"

/**
 * The demonstration the model continues from.
 *
 * ── The bug this exists for ─────────────────────────────────────────────────
 *
 * `DONE_RULE` states — twice, in almost these words — that announcing work is
 * not doing it, and that speech does not end a turn. A frontier model stopped
 * early anyway, repeatedly, on a stated intention.
 *
 * The rules were never wrong. The DEMONSTRATION was: 7 of 8 agent messages
 * ended in `<done/>`, and in all 7 the tag directly followed a `<text>` block.
 * Only 2 text blocks anywhere were mid-turn. So the pattern actually shown was
 * `<text>` → `<done/>`, over and over — and per this package's own design
 * note, a model continues a conversation far more readily than it follows a
 * description. The prose lost to the shape beneath it.
 *
 * ── Why these properties and not a snapshot ─────────────────────────────────
 *
 * A snapshot pins the words, which are meant to be edited. What must not drift
 * is the BALANCE: how often speech is shown continuing versus ending. That is
 * a property of the whole exchange, invisible in any single turn under review,
 * and it is exactly what regressed unnoticed the first time.
 */

/** The turn kinds, in order — the shape the model reads. */
const kinds = ZERO_PREFLIGHT.map(turn => turn.kind)

/**
 * The agent's messages, split exactly where `preflightEntries` splits them.
 *
 * A message ends at anything the agent did not produce — a result, a handback,
 * an interrupt, a system notice, the user speaking. Getting this wrong is what
 * made the earlier version of this file blind to the bug: treating only
 * `done`/`interrupt` as boundaries merged a whole scenario into one "message",
 * so a run of turns looked like a single continuing one and the property under
 * test was never actually measured.
 */
function agentMessages(): string[][] {
    const BOUNDARY = new Set(["stdout", "done", "interrupt", "system"])
    const messages: string[][] = []
    let current: string[] = []

    for (const kind of kinds) {
        if (kind === "user") {
            if (current.length) messages.push(current)
            current = []
            continue
        }
        if (BOUNDARY.has(kind)) {
            if (kind !== "stdout") current.push(kind)
            if (current.length) messages.push(current)
            current = []
            continue
        }
        current.push(kind)
    }
    if (current.length) messages.push(current)

    return messages
}

describe("the preflight teaches what the rules say", () => {
    test("speaking last does not always mean handing back", () => {
        // THE property the earlier version of this file missed.
        //
        // It asserted a mid-turn TEXT ratio, which counted text blocks with
        // another block after them inside the same message. That passed while
        // the real defect shipped: at the MESSAGE level, every message whose
        // last block was speech ended in `<done/>` — 7 of 7 — and the 13
        // messages that continued all ended on a `<script>`, where a pending
        // result forces continuation anyway.
        //
        // So the model learned an exact, consistent rule — SPEAKING LAST MEANS
        // HANDING BACK — and stopped after the first reply to almost anything.
        // What has to be demonstrated is choosing to continue after speaking,
        // which is a property of where messages END, not of block adjacency.
        const messages = agentMessages()
        const endsOnSpeech = messages.filter(m => {
            const at = m.indexOf("done")
            return at === -1 ? m.at(-1) === "text" : m[at - 1] === "text"
        })
        const continuing = endsOnSpeech.filter(m => !m.includes("done"))

        expect(continuing.length).toBeGreaterThanOrEqual(3)
    })

    test("speech is shown continuing at least as often as it is shown ending", () => {
        const texts = kinds.filter(k => k === "text").length
        const midTurn = kinds.filter((k, i) => k === "text" && kinds[i + 1] !== "done").length

        // The regression was 2 of 9 (22%). A model reading mostly text→done
        // learns that finishing a sentence finishes the turn, whatever the
        // contract says. Parity is the floor, not the target.
        expect(midTurn / texts).toBeGreaterThanOrEqual(0.4)
        expect(midTurn).toBeGreaterThanOrEqual(5)
    })

    test("handing back is not perfectly correlated with having just spoken", () => {
        // Measured on the raw turn order, not on messages: a handback follows
        // whatever the agent last PRODUCED, and a `stdout` between them is the
        // world answering, not the agent falling silent.
        const withDone = kinds
            .map((kind, i) => ({ kind, before: kinds.slice(0, i).filter(k => k !== "stdout").at(-1) }))
            .filter(x => x.kind === "done")
        const afterScript = withDone.filter(x => x.before !== "text")

        // Every handback following speech makes "ended a turn" and "finished a
        // sentence" indistinguishable in the data, so the model cannot learn
        // which one `<done/>` actually marks. At least one turn must end on
        // work alone.
        expect(afterScript.length).toBeGreaterThanOrEqual(1)
    })

    test("the longest exchange is one that keeps working", () => {
        // A SCENARIO — everything between two user turns. Not a "message":
        // once speech is placed after its script, a sustained run is many
        // short messages rather than one long one, which is the point. What
        // must stay true is that the heaviest exchange here is the one that
        // narrates and acts repeatedly, or the short reply-and-stop turns
        // outweigh it in the model's attention.
        const scenarios: string[][] = []
        let current: string[] = []
        for (const kind of kinds) {
            if (kind === "user") { if (current.length) scenarios.push(current); current = []; continue }
            current.push(kind)
        }
        if (current.length) scenarios.push(current)

        const longest = scenarios.reduce((a, b) => (b.length > a.length ? b : a))

        expect(longest.filter(k => k === "text").length).toBeGreaterThanOrEqual(3)
        expect(longest.filter(k => k === "script").length).toBeGreaterThanOrEqual(3)
    })

    test("only the deliberate mistake announces work and then hands back", () => {
        // A message that is nothing but speech followed by a handback, with no
        // work anywhere in its scenario, is the reported failure. Exactly one
        // exists — the mistake scenario 2 shows in order to correct it.
        const scenarios: string[][] = []
        let current: string[] = []
        for (const kind of kinds) {
            if (kind === "user") { if (current.length) scenarios.push(current); current = []; continue }
            current.push(kind)
        }
        if (current.length) scenarios.push(current)

        const announcing = scenarios.filter(s => s.join(" ") === "text done")

        expect(announcing.length).toBe(1)
    })
})

describe("the preflight stays well-formed", () => {
    test("every result answers a script that was actually sent", () => {
        const sent = new Set(ZERO_PREFLIGHT.filter(t => t.kind === "script").map(t => t.id))
        const orphans = ZERO_PREFLIGHT
            .filter(t => t.kind === "stdout")
            .map(t => t.for)
            .filter(id => !sent.has(id))

        expect(orphans).toEqual([])
    })

    test("script ids are unique", () => {
        const ids = ZERO_PREFLIGHT.filter(t => t.kind === "script").map(t => t.id)

        // Two blocks answering to one id is the ambiguity `for=` exists to
        // remove — a duplicate would silently mispair a result with its script.
        expect(new Set(ids).size).toBe(ids.length)
    })

    test("nothing the agent says follows the interrupt", () => {
        const at = kinds.indexOf("interrupt")

        // On abort the wake commits the interrupt and closes its channel, so
        // in production the next thing is always the user. An agent turn here
        // would demonstrate a sequence the runtime cannot produce, at exactly
        // the point where resuming the stopped work is most tempting.
        expect(at).toBeGreaterThanOrEqual(0)
        expect(kinds.slice(at + 1)).toEqual([])
    })
})
