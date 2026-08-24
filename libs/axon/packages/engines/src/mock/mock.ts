import type { AxonEngineDef, EngineEffort, AxonEngineDriver, AxonEngineRawEvent, AxonEngineRequest } from "@arcforge/types"
import { Collect } from "../shared"
import { Script } from "./script"
import { render } from "./grammar"

/**
 * What a handler knows about where it is, beyond the request itself.
 *
 * Drivers are stateless request→response, so a handler driving a multi-tick
 * flow cannot remember which tick it is on — it has to re-derive that every
 * call. `tick` is that derivation, done once by the engine: the number of
 * agent turns already taken since the user last spoke. Zero on the first
 * wake of a request, one on the next, and so on.
 */
export type MockContext = { tick: number }

/**
 * What a handler returns. A bare step speaks or acts and ends the turn —
 * the common case, and the only thing handlers could express before.
 *
 * `{ step, continue: true }` withholds `<done/>` so the loop wakes again,
 * which is what makes a handler able to drive a real multi-tick agent loop
 * rather than only a single reply. Map-form sequences have always had this;
 * expressing it needs a shape, because a bare `MockStep` has nowhere to
 * carry the flag.
 */
export type MockTurn = MockStep | { step: MockStep; continue?: boolean }

/**
 * Function form accepted by `Mock()`. Return what the model does next —
 * spoken text, or code to run. Mock handles wrapping and loop continuation
 * internally; the function only ever describes intent.
 *
 * The second argument carries the tick index for handlers that drive a
 * multi-step flow; one-argument handlers are unaffected.
 */
export type MockHandler = (req: AxonEngineRequest, ctx: MockContext) => MockTurn | Promise<MockTurn>

/** Run code in the capsule. The loop continues automatically afterward. */
export type MockRun = { code: string }

/** One step: spoken text (terminates the loop) or code to run (continues it). */
export type MockStep = string | MockRun

/**
 * A single step, or an ordered sequence of steps for a matched pattern —
 * one step per call that matches the pattern, in order. Once the sequence
 * is exhausted, further matching calls repeat the last step.
 */
export type MockReply = MockStep | MockStep[]

/**
 * Input accepted by `Mock()`.
 *
 * Pass a handler for full control, or a map of substring patterns to replies
 * — the last user message is matched case-insensitively against each key.
 * No match echoes the message back as spoken text.
 */
export type MockInput = MockHandler | Record<string, MockReply>

/** Portable effort setting. Mock accepts it to share the engine config shape, then ignores it. */
export type MockOptions = { effort?: EngineEffort }

/** Declares a step that runs code in the capsule instead of speaking. */
export function run(code: string): MockRun {
    return { code }
}

/**
 * Mock engine — deterministic local inference for testing and zero-config init.
 *
 * Every response is either spoken text or a `run()` step — what the model
 * says or does next. Mock owns all output formatting and loop continuation
 * internally; nothing about the underlying output grammar is part of this API.
 * Deciding what comes next is the Script leaf's job — this orchestrator only
 * streams whatever it resolves.
 *
 * ```ts
 * import { Mock, run } from "@arcforge/engines/mock"
 *
 * providers: [Mock()]                                   // echoes the user's message
 * providers: [Mock({ "hello": "Hi there!" })]           // single reply per match
 * providers: [Mock({ "/run": [run("1 + 1"), "the answer is above"] })] // sequence
 * providers: [Mock((req) => `You said: ${extractUserText(req)}`)]
 * ```
 *
 * Streaming: spoken text is chunked at word boundaries with ~5ms delay between chunks.
 *
 * @see https://axon.arclabs.it/docs/v2/agent/engines/mock
 */
export function Mock(input?: MockInput | MockOptions, tokenms?: number): AxonEngineDef {
    const script = Script(isOptions(input) ? undefined : input)

    return {
        name: "mock",
        ...(isOptions(input) && input.effort !== undefined ? { effort: input.effort } : {}),

        create(): AxonEngineDriver {
            return {
                async *stream(req: AxonEngineRequest): AsyncGenerator<AxonEngineRawEvent> {
                    const collect = Collect({ provider: "mock", model: "mock" })
                    const { step, isLast } = await script.next(req)
                    const text = render(step, isLast)

                    const words = text.split(" ")
                    for (const [i, word] of words.entries()) {
                        const chunk = i === 0 ? word : " " + word
                        const event = collect.feed({ type: "text:delta", content: chunk })
                        if (event) yield event
                        await sleep(tokenms ?? 1)
                    }

                    yield collect.done()
                },
            }
        },
    }
}

function isOptions(input: MockInput | MockOptions | undefined): input is MockOptions {
    return !!input && typeof input === "object" && !Array.isArray(input) && Object.keys(input).every(key => key === "effort")
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms))
}
