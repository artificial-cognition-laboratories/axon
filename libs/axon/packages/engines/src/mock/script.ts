import type { AxonEngineRequest } from "@arcforge/types"
import type { MockInput, MockStep, MockTurn } from "./mock"
import { MOCK_COMMANDS } from "./commands"

/**
 * The boundary the AIR renderer emits between the few-shot preflight and the
 * real conversation. The preflight's turns are deliberately indistinguishable
 * from genuine ones — that is what makes few-shot work — so this marker is the
 * only thing that says where reading should stop.
 */
const SESSION_START = `<system type="session:start"/>`

/**
 * Script — the mock's counterpart to a provider backend: instead of a wire
 * conversation it owns "what does the model do next". Pattern matching,
 * sequence progression, and reading progress back out of the rendered
 * timeline all live here; the orchestrator only streams whatever step this
 * resolves. Stateless request→response, like every driver.
 */
export function Script(input?: MockInput) {
    return {
        next: buildResolver(input),
    }
}

/**
 * Distinguishes the explicit turn shape from a bare step. A `run()` step is
 * also an object, so the discriminator has to be the `step` key rather than
 * merely "is an object" — otherwise `return run("...")` would be read as a
 * turn with no step and stream `undefined`.
 */
function isTurn(turn: MockTurn): turn is { step: MockStep; continue?: boolean } {
    return typeof turn === "object" && turn !== null && "step" in turn
}

function buildResolver(input: MockInput | undefined): (req: AxonEngineRequest) => Promise<{ step: MockStep; isLast: boolean }> {
    if (!input) {
        /**
         * A bare `Mock()` answers the standard command set, and echoes anything
         * it does not recognise.
         *
         * `mock` is now in every pool without being declared, so `*mock:mock`
         * is always reachable — and a route that echoes the prompt back is one
         * that exists and does nothing worth doing. MOCK_COMMANDS covers the UI
         * surfaces that are otherwise hard to provoke on purpose (a denied
         * call, a non-zero exit, a reply long enough to wrap).
         *
         * The echo REMAINS as the fallback. It is what makes a mock useful as a
         * plain double — a test asserting "the reply came back" reads its own
         * prompt — and the commands are additive rather than a replacement.
         */
        const commands = buildResolver(MOCK_COMMANDS)
        return async (req) => {
            const text = extractUserText(req).toLowerCase()
            const matched = Object.keys(MOCK_COMMANDS as Record<string, unknown>)
                .some(pattern => text.includes(pattern.toLowerCase()))

            return matched ? commands(req) : { step: extractUserText(req), isLast: true }
        }
    }

    if (typeof input === "function") {
        // The tick index is computed HERE rather than left to the handler:
        // it is the same derivation map-form sequences already do, and a
        // handler that had to reimplement it would be reading the rendered
        // timeline — the one part of the request whose shape is not a
        // handler's business.
        return async (req) => {
            const turn = await input(req, { tick: countPriorSteps(req) })
            return isTurn(turn)
                ? { step: turn.step, isLast: !turn.continue }
                : { step: turn, isLast: true }
        }
    }

    return async (req) => {
        const text = extractUserText(req).toLowerCase()

        for (const [pattern, reply] of Object.entries(input)) {
            if (!text.includes(pattern.toLowerCase())) continue

            if (!Array.isArray(reply)) return { step: reply, isLast: true }

            // No terminal padding: a run() step yields like any other, so a
            // sequence ending in one hands control back rather than replaying
            // forever. (It used to need a silent trailing step, back when
            // only spoken text could carry <done/>.)
            const sequence = reply

            // How many of this sequence's steps have already run in this
            // conversation? Progress is read back out of the timeline every
            // call — drivers are stateless request→response.
            const step = countPriorSteps(req)
            const index = Math.min(step, sequence.length - 1)
            const resolved = sequence[index]
            // `sequence` is non-empty (it came from a matched pattern), so
            // `index` is in bounds —
            // but under noUncheckedIndexedAccess only a real check narrows it,
            // and an empty array here would otherwise stream `undefined` as
            // a step and fail somewhere far less obvious.
            if (resolved === undefined) throw new Error(`[mock] empty step sequence for a matched pattern`)
            return { step: resolved, isLast: index >= sequence.length - 1 }
        }

        return { step: extractUserText(req), isLast: true }
    }
}

/**
 * Counts agent turns since the pattern-triggering user message — one turn
 * per tick this sequence has already produced, whatever its content. Content
 * matching would be fragile here: the rendered history re-indents code,
 * escapes text, and assigns short ids, so it never matches a step's raw
 * value verbatim.
 *
 * Counts ROLES, not tags. The history renders as real user/assistant messages
 * now, so `<user>`/`<agent>` markup no longer exists to count — and the roles
 * say the same thing more directly. The document form is still handled for
 * callers pinned to it.
 */
function countPriorSteps(req: AxonEngineRequest): number {
    // Document form is decided by SHAPE, not by a zero count — zero assistant
    // turns is the correct answer on the first tick, and treating it as "try
    // the other parser" made the mock replay step 0 forever.
    const document = req.messages.find(m => m.content.trimStart().startsWith("<timeline>"))
    if (document) {
        const lastUserStart = document.content.lastIndexOf("<user")
        if (lastUserStart === -1) return 0
        return (document.content.slice(lastUserStart).match(/<agent>/g) ?? []).length
    }

    // Conversation form: the model's own turns since the newest thing a
    // PERSON said. A runtime-authored user turn (stdout, a correction) does
    // not restart the count — the sequence is still answering the same
    // request.
    let steps = 0
    for (let i = req.messages.length - 1; i >= 0; i--) {
        const message = req.messages[i]!
        if (message.role === "assistant") { steps++; continue }
        if (message.role !== "user") continue
        const content = message.content.trimStart()
        // The preflight is a few-shot demonstration rendered as genuine user
        // and assistant turns, so nothing about its SHAPE distinguishes it
        // from real history — its agent turns would be counted as steps of
        // this sequence. SESSION_START is the boundary the renderer emits for
        // exactly this question; stop there.
        if (content.startsWith(SESSION_START)) return steps
        if (content.startsWith("<stdout") || content.startsWith("<system")) continue
        break
    }
    return steps
}

/**
 * Extract the user's actual message text from a rendered request.
 *
 * ```ts
 * const engine = Mock((req) => `You said: ${extractUserText(req)}`)
 * ```
 *
 * The history renders as real chat messages, so the newest `user` message IS
 * the user's words — no unwrapping needed. Two shapes still need handling: a
 * runtime-authored user turn (a `<stdout>` result, a correction) is not
 * something a person said and is skipped, and a caller pinned to the document
 * form sends one `<timeline>` blob to dig the innermost `<user>` out of.
 */
export function extractUserText(req: AxonEngineRequest): string {
    for (let i = req.messages.length - 1; i >= 0; i--) {
        const message = req.messages[i]
        if (message?.role !== "user") continue

        // The session:start marker heads the FIRST real user turn rather than
        // standing as a message of its own (providers reject two adjacent user
        // turns), so the user's words sit behind it. Strip it before the
        // runtime-authored check below, which would otherwise read the whole
        // turn as a `<system>` block and skip the only real message there is —
        // landing on the preflight's demonstration turns instead.
        const trimmed = message.content.trim()
        const content = (trimmed.startsWith(SESSION_START) ? trimmed.slice(SESSION_START.length) : trimmed).trim()

        // The user's words, wherever they sit in this message.
        //
        // Read BEFORE the runtime-authored check below, because one message
        // can carry both. A preflight ending on an interrupt folds into the
        // session's opening turn (see render/index.ts), so that turn is
        // `<interrupt/>` + `<text from="user">` together — and a prefix test
        // would classify the whole thing as runtime-authored and skip past
        // the only real message there is.
        //
        // Both render forms carry the words inside a user block: the document
        // as the last one in a <timeline>, the conversation as this message.
        // The greedy prefix takes the LAST in either case.
        const match = content.match(/.*<(?:user|text from="user")[^>]*>([\s\S]*?)<\/(?:user|text)>/s)
        if (match?.[1] !== undefined) return match[1].trim()

        // Runtime-authored turns are not the user speaking. Keep looking back.
        if (content.startsWith("<stdout") || content.startsWith("<system") || content.startsWith("<interrupt")) continue

        // Not a rendered turn at all — a hand-built message in a unit test.
        return content
    }
    return ""
}
