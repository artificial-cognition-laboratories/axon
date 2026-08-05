import type { AxonEngineDef, AxonEngineDriver, AxonEngineRawEvent, AxonEngineRequest } from "@arcforge/types"
import { Collect } from "../shared"
import { Script } from "./script"

/**
 * Function form accepted by `Mock()`. Return what the model does next —
 * spoken text, or code to run. Mock handles wrapping and loop continuation
 * internally; the function only ever describes intent.
 */
export type MockHandler = (req: AxonEngineRequest) => MockStep | Promise<MockStep>

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
 * engine: Mock()                                       // echoes the user's message
 * engine: Mock({ "hello": "Hi there!" })                // single reply per match
 * engine: Mock({ "/run": [run("1 + 1"), "the answer is above"] }) // sequence
 * engine: Mock((req) => `You said: ${extractUserText(req)}`)
 * ```
 *
 * Streaming: spoken text is chunked at word boundaries with ~5ms delay between chunks.
 *
 * @see https://axon.arclabs.it/docs/v2/agent/engines/mock
 */
export function Mock(input?: MockInput, tokenms?: number): AxonEngineDef {
    const script = Script(input)

    return {
        name: "mock",

        create(): AxonEngineDriver {
            return {
                async *stream(req: AxonEngineRequest): AsyncGenerator<AxonEngineRawEvent> {
                    const collect = Collect({ provider: "mock", model: "mock" })
                    const { step, isLast } = await script.next(req)
                    const text = wrap(step, isLast)

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

/**
 * Wraps a step as its output block. Internal — never exposed to callers.
 *
 * <done/> only ever terminates on a spoken-text step, per the AIR grammar
 * (a run() step always continues — the runtime executes it and returns
 * control for another tick, no exceptions). A non-final text step in a
 * sequence must NOT emit <done/> either — "hi" then "how are you?" is a
 * valid two-turn conversation, not two independent one-shot replies.
 */
function wrap(step: MockStep, isLast: boolean): string {
    if (typeof step === "string") return isLast ? `<text>${step}</text><done/>` : `<text>${step}</text>`
    return `<typescript>${step.code}</typescript>`
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms))
}
