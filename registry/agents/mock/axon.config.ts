import { MockCommands } from "./src/mock/engine"

/**
 * mock — a deterministic agent for exercising anything that talks to Axon.
 *
 * There is no model here and nothing to pay for. Every reply is written into
 * the agent, addressed by a slash word: `/markdown` to see how a surface
 * renders a document, `/log` to watch a real capsule execution come back on
 * the next tick, `/loop 5` to watch five ticks of a real agent loop. `/help`
 * lists the set.
 *
 * Reach for it when you are building the thing AROUND an agent — a TUI
 * extension, a fleet script, an HTTP client, a CI job — and you need the
 * other end of the wire to do something specific, immediately, the same way
 * every time.
 *
 * Everything except inference is real: real kernel, real capsule, real
 * policy. `/log` and `/tool` genuinely execute, which is why they are worth
 * watching rather than merely reading.
 *
 * https://axon.arclabs.it/docs/v2/agent/config
 */
export default defineAgent({
    // A provider like any other — MockCommands() returns a ProviderEntry, so
    // every role resolves against it and nothing reaches a network.
    model: "mock:mock",
    providers: [MockCommands()],
})
