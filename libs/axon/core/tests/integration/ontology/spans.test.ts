import { Axon } from "../../setup/axon"
import { Mock } from "@arcforge/engines"
import { isSpanEnd, isSpanStart, spanStem } from "@arcforge/types"
import type { AxonEvent } from "@arcforge/types"

/**
 * The ontology's regression guard.
 *
 * Every convergence rule the event system was rebuilt around is asserted
 * here against a REAL runtime driven through its public API — not against
 * the type declarations, which can agree with themselves while the emitters
 * drift. If a future change opens a span it never closes, ships a
 * completion with no duration, or invents a bespoke verb, this fails.
 *
 * Reads only observables: session.log, session.kernelLog, session.entries.
 */

type AnyEvent = { type: string; time: { seq: number }; data: Record<string, unknown>; context: { runId?: string } }

/** Boot a runtime, drive one full wake through it, tear it down. */
async function fullLifecycle() {
    const runtime = await Axon({
        blueprint: {
            config: {
                providers: [Mock({
                    hello: "<typescript>1 + 1</typescript>",
                })],
            },
        },
    })

    await runtime.kernel.request({ content: "hello" })
    await runtime.shutdown()

    const all = [
        ...runtime.session.log,
        ...runtime.session.kernelLog,
        ...runtime.session.entries,
    ] as unknown as AnyEvent[]

    // One writer, one total order — sorting by seq reconstructs exactly the
    // order things happened, which is what every rule below relies on.
    return all.sort((a, b) => a.time.seq - b.time.seq)
}

describe("Event ontology", () => {
    it("closes every span it opens", async () => {
        const events = await fullLifecycle()

        // A span's identity is its stem plus whatever names this particular
        // bracket among its siblings (tick number, phase name, command id).
        const open = new Map<string, number>()
        for (const event of events) {
            const key = `${spanStem(event.type)}|${identity(event)}`
            if (isSpanStart(event.type)) open.set(key, (open.get(key) ?? 0) + 1)
            else if (isSpanEnd(event.type)) open.set(key, (open.get(key) ?? 0) - 1)
        }

        const unbalanced = [...open.entries()].filter(([, depth]) => depth !== 0)
        expect(unbalanced).toEqual([])
    })

    it("opens at least the spans a full lifecycle must produce", async () => {
        const events = await fullLifecycle()
        const types = new Set(events.map(e => e.type))

        // Not an exhaustive list — a floor. These are the brackets that must
        // exist for boot, cognition, execution and teardown to be traceable
        // at all; each was a real gap at some point in this convergence.
        for (const required of [
            "axon:boot:start", "axon:boot:complete",
            // Boot's interior. axon:boot used to bracket the whole runtime
            // construction and nothing inside it, so half a boot was one
            // unlabelled gap — these are what closed it.
            "axon:cognet:start", "axon:cognet:complete",
            "axon:inference:start", "axon:inference:complete",
            "axon:kernel:start", "axon:kernel:complete",
            "cognet:load:start", "cognet:load:complete",
            "kernel:run:start", "kernel:run:complete",
            "kernel:engine:start", "kernel:engine:complete",
            "cognet:tick:start", "cognet:tick:complete",
            "cognet:phase:start", "cognet:phase:complete",
            "cognet:unload:start", "cognet:unload:complete",
            "axon:shutdown:start", "axon:shutdown:complete",
        ]) {
            expect(types).toContain(required)
        }
    })

    it("carries durationMs on every span end that settled", async () => {
        const events = await fullLifecycle()

        // :interrupted is exempt by design — cancellation is a settled
        // outcome, and several interrupt payloads carry no timing.
        const settled = events.filter(e =>
            e.type.endsWith(":complete") || e.type.endsWith(":failed"))
        expect(settled.length).toBeGreaterThan(0)

        const missing = settled
            .filter(e => typeof e.data.durationMs !== "number")
            .map(e => e.type)
        expect(missing).toEqual([])
    })

    it("uses only the span vocabulary — no bespoke lifecycle verbs", async () => {
        const events = await fullLifecycle()

        // The flame graph pairs bars by suffix alone, so a family that
        // invents `loaded`/`spawned`/`restarting` is invisible to it. Catch
        // the shapes that have actually appeared here before.
        const bespoke = [...new Set(events.map(e => e.type))].filter(type =>
            /:(loaded|unloaded|spawned|restarting|restarted|exit|created|updated|ended)$/.test(type)
            // capsule:tool:unloaded and capsule:exit are deliberate: a
            // synchronous delete and a process-death fact, neither bracketed.
            && type !== "capsule:tool:unloaded"
            && type !== "capsule:exit")
        expect(bespoke).toEqual([])
    })

    it("stamps every event a wake produced with the run that caused it", async () => {
        const events = await fullLifecycle()

        const runStart = events.find(e => e.type === "kernel:run:start")
        const runEnd = events.find(e => e.type === "kernel:run:complete")
        expect(runStart?.context.runId).toBeTruthy()

        // Everything between the run's brackets belongs to that run — this
        // is what makes bracket-matching work without a parent pointer.
        const inside = events.filter(e =>
            e.time.seq > runStart!.time.seq && e.time.seq < runEnd!.time.seq)
        expect(inside.length).toBeGreaterThan(0)

        const orphaned = inside
            .filter(e => e.context.runId !== runStart!.context.runId)
            .map(e => e.type)
        expect(orphaned).toEqual([])
    })

    it("accounts for boot's wall time in named spans, leaving no large gap", async () => {
        const events = await fullLifecycle()

        // WHY THIS IS A TEST. The boot trace is a user-facing surface, and
        // an unlabelled hole in it reads as time the system cannot account
        // for. This regressed once already: axon:boot bracketed 540ms while
        // its named children summed to ~380ms, and the missing 271ms — half
        // the boot — was a cold model-catalogue fetch nothing measured.
        //
        // The assertion is on the GAP, not on a duration budget: how long a
        // boot takes depends on the machine, but whether the trace explains
        // where that time went does not.
        const boot = events.find(e => e.type === "axon:boot:start")!
        const done = events.find(e => e.type === "axon:boot:complete")!
        const inside = events.filter(e =>
            e.time.seq > boot.time.seq && e.time.seq <= done.time.seq)

        // Walk adjacent events inside the bracket. Any stretch where nothing
        // was reported for a meaningful span of time is an accountability
        // hole, and the event AFTER it names what the boot was doing.
        const clock = (e: AnyEvent) => (e.time as { ms?: number }).ms ?? 0
        let previous = clock(boot)
        const holes: Array<{ before: string; ms: number }> = []
        for (const event of inside) {
            const gap = clock(event) - previous
            if (gap > GAP_BUDGET_MS) holes.push({ before: event.type, ms: gap })
            previous = clock(event)
        }

        expect(holes).toEqual([])
    })

    it("keeps failure payloads structured, never a bare string", async () => {
        const events = await fullLifecycle()

        const withError = events.filter(e => "error" in e.data && e.data.error !== undefined)
        for (const event of withError) {
            // envelope rule 4 — the full AxonError (or its serialized shape
            // across the capsule's process boundary), never a message.
            expect(typeof event.data.error).toBe("object")
            expect((event.data.error as { isAxonError?: boolean }).isAxonError).toBe(true)
        }
    })
})

/**
 * How long boot may go unreported before it counts as an accountability hole.
 *
 * Generous deliberately: this is a floor against UNTRACED WORK, not a
 * performance budget. A slow machine, a cold import or a loaded CI box may
 * legitimately make any single step take a while — what must not happen is
 * that it takes a while with no span saying what it was.
 */
const GAP_BUDGET_MS = 150

/** What distinguishes this bracket from its siblings of the same stem. */
function identity(event: AnyEvent): string {
    const d = event.data
    const parts: string[] = []
    if (typeof d.tick === "number") parts.push(`t${d.tick}`)
    if (typeof d.phase === "string") parts.push(`p${d.phase}`)
    if (typeof d.system === "string") parts.push(`s${d.system}`)
    if (typeof d.id === "string") parts.push(`i${d.id}`)
    if (typeof d.procId === "string") parts.push(`i${d.procId}`)
    if (typeof d.namespace === "string") parts.push(`n${d.namespace}`)
    if (typeof d.name === "string") parts.push(`n${d.name}`)
    if (typeof d.fn === "string") parts.push(`f${d.fn}`)
    // engine calls interleave only with a concurrent sibling; their span id
    // is the discriminator when one exists.
    const spanId = (event as unknown as AxonEvent<never>).context && (event.context as { spanId?: string }).spanId
    if (spanId) parts.push(`x${spanId}`)
    return parts.join("|")
}
