import { readSession, STIMULUS_TRANSIENT_EVENTS } from "@arcforge/types"
import type { AxonEntry, AxonEvent } from "@arcforge/types"
import { Axon } from "../../setup/axon"
import { Mock } from "@arcforge/engines/mock"

/**
 * Overlapping wakes, and what had to become async-scoped to allow them.
 *
 * A continuous cognet ticks whether or not the previous wake finished —
 * deliberation that outlasts a tick must not stop the next tick from
 * hearing, because stimuli are transient and a skipped tick is a tick that
 * never heard. Three module-level assumptions stood in the way, and each is
 * pinned here: the run a syscall belongs to, the clock a phase times
 * against, and the stack readSession() rebuilds nesting from.
 */
describe("Concurrent wakes", () => {
    describe("transient stimuli", () => {
        it("delivers a dense stimulus to the cognet without writing it to the log", async () => {
            const runtime = await Axon({ engine: Mock() })

            const entry = await runtime.session.stimuli.ingest("cognet:stimulus:audio", {
                source: { channel: "mic0" },
                ref: { uri: "buffer://0", mime: "audio/pcm" },
                durationMs: 32,
            })

            // Stamped like any other entry — a cognet cannot tell the
            // difference, and should not need to.
            expect(entry.id).toBeString()
            expect(entry.type).toBe("cognet:stimulus:audio")
            expect(entry.context.sessionId).toBe(runtime.session.id)

            // ...and absent from the durable record.
            expect(runtime.session.entries.some(e => e.type === "cognet:stimulus:audio")).toBe(false)

            // Still delivered: the wake that drains next receives it.
            expect(runtime.session.stimuli.drain().map(s => s.id)).toEqual([entry.id])

            await runtime.shutdown()
        })

        it("still commits sparse stimuli — text is what someone said", async () => {
            const runtime = await Axon({ engine: Mock() })

            await runtime.session.stimuli.ingest("cognet:stimulus:text", {
                source: { channel: "user" },
                content: "hello",
            })

            expect(runtime.session.entries.some(e => e.type === "cognet:stimulus:text")).toBe(true)

            await runtime.shutdown()
        })

        it("consumes a seq for a transient stimulus, so the record has no false adjacency", async () => {
            // Two durable entries either side of a sensation must not look
            // consecutive: something really happened between them.
            const runtime = await Axon({ engine: Mock() })

            await runtime.session.stimuli.ingest("cognet:stimulus:text", { source: { channel: "user" }, content: "a" })
            const transient = await runtime.session.stimuli.ingest("cognet:stimulus:audio", {
                source: { channel: "mic0" },
                ref: { uri: "buffer://1", mime: "audio/pcm" },
            })
            await runtime.session.stimuli.ingest("cognet:stimulus:text", { source: { channel: "user" }, content: "b" })

            const text = runtime.session.entries.filter(e => e.type === "cognet:stimulus:text")
            const [first, second] = text.slice(-2)
            expect(second!.time.seq - first!.time.seq).toBeGreaterThan(1)
            expect(transient.time.seq).toBeGreaterThan(first!.time.seq)
            expect(transient.time.seq).toBeLessThan(second!.time.seq)

            await runtime.shutdown()
        })

        it("names dense kinds only — a stimulus set that grew to include text would erase the record", async () => {
            expect(STIMULUS_TRANSIENT_EVENTS.has("cognet:stimulus:audio")).toBe(true)
            expect(STIMULUS_TRANSIENT_EVENTS.has("cognet:stimulus:visual")).toBe(true)
            expect(STIMULUS_TRANSIENT_EVENTS.has("cognet:stimulus:text")).toBe(false)
            expect(STIMULUS_TRANSIENT_EVENTS.has("cognet:stimulus:field")).toBe(false)
        })
    })

    describe("span nesting under interleaved runs", () => {
        /** A span pair as the log records it, for one run. */
        function span(seq: number, type: string, runId: string): AxonEvent<Record<string, never>, string> {
            return {
                id: `e${seq}`,
                type,
                time: { ms: seq, seq },
                context: { agentId: "a", sessionId: "s", runId },
                data: {},
            } as unknown as AxonEvent<Record<string, never>, string>
        }

        it("keeps two overlapping runs as siblings, not one nested in the other", () => {
            // Wake A starts, wake B starts before A ends, both close. In seq
            // order that LOOKS like containment, and a single open-span stack
            // read it that way — producing a flame graph describing a call
            // structure that never happened.
            const events = [
                span(0, "kernel:run:start", "A"),
                span(1, "kernel:run:start", "B"),
                span(2, "kernel:run:complete", "B"),
                span(3, "kernel:run:complete", "A"),
            ]

            const tree = readSession(events as never)

            expect(tree.length).toBe(2)
            for (const node of tree) {
                expect(node.stem).toBe("kernel:run")
                expect(node.outcome).toBe("complete")
                // The point: neither run adopted the other.
                expect(node.children.length).toBe(0)
            }
        })

        it("still nests genuine containment within one run", () => {
            // The property that must survive: inside a single line of
            // execution, innermost-still-open is exact.
            const events = [
                span(0, "kernel:run:start", "A"),
                span(1, "cognet:tick:start", "A"),
                span(2, "cognet:tick:complete", "A"),
                span(3, "kernel:run:complete", "A"),
            ]

            const tree = readSession(events as never)

            expect(tree.length).toBe(1)
            expect(tree[0]!.stem).toBe("kernel:run")
            expect(tree[0]!.children.length).toBe(1)
            expect(tree[0]!.children[0]!.stem).toBe("cognet:tick")
        })

        it("does not let one run's phases fall into another run's span", () => {
            const events = [
                span(0, "kernel:run:start", "A"),
                span(1, "kernel:run:start", "B"),
                span(2, "cognet:phase:start", "B"),
                span(3, "cognet:phase:complete", "B"),
                span(4, "kernel:run:complete", "B"),
                span(5, "kernel:run:complete", "A"),
            ]

            const tree = readSession(events as never)
            const a = tree.find(n => n.start?.context.runId === "A")
            const b = tree.find(n => n.start?.context.runId === "B")

            expect(a!.children.length).toBe(0)
            expect(b!.children.length).toBe(1)
            expect(b!.children[0]!.stem).toBe("cognet:phase")
        })
    })
})
