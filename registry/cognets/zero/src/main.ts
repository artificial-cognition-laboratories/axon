// zero — the first cognet. A raw script: this file IS the brain.
//
// Runs once at load(), with the ambient globals live (kernel, loop, phase,
// system, blueprint). Module/closure scope is resident RAM: alive across
// wakes, rebuilt from the episodic log on cold boot (plugins/setup.ts),
// gone without loss on kill -9.
//
// Strategy: single engine, sequential ticks, stops when the model says
// <done/>. The cognet has no session write access at all — its entire
// vocabulary for touching the world is kernel.output() (unmediated
// emission) and kernel.run() (mediated request, platform-committed).
// Context is the cognet's OWN resident model (src/state.ts), kept
// lockstep with the durable log by sync()ing the log tail at each tick
// start — stimuli, its own outputs, and action results all arrive back
// through that one door, which is why the wake's `stimuli` arg goes
// unused here: for a log-derived mind the log tail IS the diff.
import { Air } from "@arcforge/cognet/air"
import { state, sync } from "./state"

const air = Air()

loop(async ({ signal, stop }) => {
    // ── sense: fold everything new since the last tick ─────────────────────
    // First tick of a wake this pulls the triggering stimuli; later ticks
    // pull the cognet:action:typescript/cognet:action:result entries the kernel committed
    // for last tick's run() — that's how tool results re-enter the model.
    await phase("sync", async () => {
        sync()
    })

    // ── render: the model's context, from the resident model alone ─────────
    const messages = await phase("render", async () => {
        return air.render({
            base: await kernel.base(),
            scope: kernel.scope(),
            history: state.entries,
        })
    })

    // ── invoke: one engine call; decide per block what becomes real ────────
    const { blocks, done } = await phase("invoke", async () => {
        const collected: string[] = []
        let stopped = false
        // the open text emission — one correlation group per spoken block
        // (AxonChunk standard): deltas emit as chunks of it, engine:text
        // closes it. zero just declares as the emission happens; whether
        // anyone renders the partials is downstream's business.
        let speaking: string | null = null

        for await (const event of kernel.stream({ messages, signal })) {
            switch (event.type) {
                case "engine:text:delta":
                    if (!speaking) speaking = crypto.randomUUID()
                    await kernel.output("cognet:output:text", { content: event.content, chunk: { of: speaking } })
                    break

                case "engine:text":
                    // the block is complete — close the group (all content
                    // already emitted as chunks), or, if this engine never
                    // streamed deltas, emit the whole block self-contained
                    if (speaking) {
                        await kernel.output("cognet:output:text", { content: "", chunk: { of: speaking, final: true } })
                        speaking = null
                    } else {
                        await kernel.output("cognet:output:text", { content: event.content })
                    }
                    break

                case "engine:typescript":
                    // don't run mid-stream: collect, act once the model has
                    // finished the whole message, so blocks run concurrently
                    // and an abort can't leave half a message acted on
                    collected.push(event.content)
                    break

                case "engine:output:error":
                    // the model broke the AIR contract — surface it as an
                    // ordinary fact so next tick's render shows the model
                    // its own violation and it self-corrects.
                    await kernel.output("cognet:output:text", {
                        content: `[format] ${event.code}: ${event.message}`,
                    })
                    break

                case "engine:stop":
                    // the model's own explicit <done/> — causal, never inferred
                    stopped = true
                    break

                case "engine:done":
                    // terminal accounting (billing meta) — nothing to decide
                    break
            }
        }

        return { blocks: collected, done: stopped }
    })

    // ── act: run what the model asked for ───────────────────────────────────
    // kernel.run() commits cognet:action:typescript/cognet:action:result itself; the
    // results re-enter the model via next tick's sync, and that tick's
    // render shows the model its own stdout. Results aren't inspected here —
    // success and failure both flow back through the log identically.
    if (blocks.length > 0) {
        await phase("act", async () => {
            await kernel.run(blocks, { signal })
        })
    }

    // ── yield: hand control back only when the model said so AND nothing is
    // still pending a result it hasn't seen. Code this tick means another
    // tick regardless of <done/> — the model must witness its own results
    // before the wake can honestly end.
    if (done && blocks.length === 0) stop()
})
