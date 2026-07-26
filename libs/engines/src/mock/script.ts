import type { AxonEngineRequest } from "@arcforge/types"
import type { MockInput, MockStep } from "./mock"

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

function buildResolver(input: MockInput | undefined): (req: AxonEngineRequest) => Promise<{ step: MockStep; isLast: boolean }> {
    if (!input) {
        return async (req) => ({ step: extractUserText(req), isLast: true })
    }

    if (typeof input === "function") {
        return async (req) => ({ step: await input(req), isLast: true })
    }

    return async (req) => {
        const text = extractUserText(req).toLowerCase()

        for (const [pattern, reply] of Object.entries(input)) {
            if (!text.includes(pattern.toLowerCase())) continue

            if (!Array.isArray(reply)) return { step: reply, isLast: true }

            // A sequence must end in a step that actually stops the loop
            // (spoken text). A run() step never emits <done/> — so a
            // sequence ending in run() would replay its last step forever.
            // Auto-append a silent terminal step rather than require every
            // caller to remember one: the array's end IS the end of the
            // conversation.
            const sequence = needsTerminal(reply) ? [...reply, ""] : reply

            // How many of this sequence's steps have already run in this
            // conversation? Progress is read back out of the timeline every
            // call — drivers are stateless request→response.
            const step = countPriorSteps(req)
            const index = Math.min(step, sequence.length - 1)
            return { step: sequence[index], isLast: index >= sequence.length - 1 }
        }

        return { step: extractUserText(req), isLast: true }
    }
}

function needsTerminal(sequence: MockStep[]): boolean {
    const last = sequence[sequence.length - 1]
    return typeof last !== "string"
}

/**
 * Counts agent turns since the pattern-triggering user message — one turn
 * per tick this sequence has already produced, whatever its content. Content
 * matching would be fragile here: the rendered timeline re-indents code,
 * escapes text, and assigns short ids, so it never matches a step's raw
 * value verbatim.
 */
function countPriorSteps(req: AxonEngineRequest): number {
    const timeline = req.messages.map(m => m.content).join("\n")
    const lastUserStart = timeline.lastIndexOf("<user")
    if (lastUserStart === -1) return 0
    const after = timeline.slice(lastUserStart)
    return (after.match(/<agent>/g) ?? []).length
}

/**
 * Extract the user's actual message text from an AIR-formatted request.
 *
 * The kernel sends the full context window as the last user role message —
 * a large XML blob containing <meta>, <agent>, <timeline> etc. This pulls
 * the innermost user turn text out of the timeline.
 *
 * ```ts
 * const engine = Mock((req) => `You said: ${extractUserText(req)}`)
 * ```
 */
export function extractUserText(req: AxonEngineRequest): string {
    for (let i = req.messages.length - 1; i >= 0; i--) {
        if (req.messages[i].role === "user") {
            // AIR format: the last user role message is the full <timeline> block.
            // The user's actual text is in the last <user ...>...</user> turn —
            // subsequent entries (agent, capsule) may follow it in the timeline.
            const match = req.messages[i].content.match(/.*<user[^>]*>([\s\S]*?)<\/user>/s)
            if (match) return match[1].trim()
            // Not AIR format — return raw content (e.g. in unit tests)
            return req.messages[i].content
        }
    }
    return ""
}
