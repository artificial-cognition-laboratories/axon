import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/** One question, as Jev's decisions API takes it. */
export type Question =
    | { type: "noul"; instructions: string }
    | { type: "score"; instructions: string; criteria: readonly string[] }
    | { type: "choice"; instructions: string; criteria: Readonly<Record<string, string>> }

/** One answer, as Jev returns it. A noul carries no confidence — absent, not null. */
export type Answer =
    | { type: "noul"; noul: number }
    | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
    | { type: "score"; score: number; confidence: number; probabilities: Record<string, number> }

export type JevOpts = {
    key: string
    model: string
    /** Where answers are kept, keyed by everything that decides them: model, state and questions. */
    cache: string
    /** Calls in flight at once. */
    concurrency: number
}

/**
 * Jev — TypeSafe's decision model, through OpenRouter's decisions endpoint.
 *
 * A lab client, not the platform's: once Jev earns its place it is reached
 * through a `decide@1` interface like any other model, and this goes.
 *
 * An answer is cached by the exact model, state and questions that produced
 * it, so a re-run costs nothing — and `fresh` bypasses the cache, which is the
 * only way a stability measurement means anything.
 */
export function Jev(opts: JevOpts) {
    mkdirSync(opts.cache, { recursive: true })
    let inFlight = 0
    const waiting: Array<() => void> = []
    let calls = 0
    let cost = 0

    return {
        get spent() { return { calls: calls, usd: cost } },

        async decide(state: unknown, questions: Readonly<Record<string, Question>>, fresh = false): Promise<Record<string, Answer>> {
            const file = join(opts.cache, `${hash(opts.model, state, questions)}.json`)
            if (!fresh && existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as Record<string, Answer>
            await slot()
            try {
                const answers = await request(state, questions)
                writeFileSync(file, JSON.stringify(answers))
                return answers
            } finally {
                inFlight--
                waiting.shift()?.()
            }
        },
    }

    async function slot(): Promise<void> {
        if (inFlight >= opts.concurrency) await new Promise<void>(resolve => waiting.push(resolve))
        inFlight++
    }

    async function request(state: unknown, questions: Readonly<Record<string, Question>>, attempt = 1): Promise<Record<string, Answer>> {
        const response = await fetch("https://openrouter.ai/api/alpha/decisions", {
            method: "POST",
            headers: { Authorization: `Bearer ${opts.key}`, "Content-Type": "application/json" },
            body: JSON.stringify({ model: opts.model, state: state, questions: questions }),
        })
        // Rate limits and server errors are worth a second ask; anything else is our mistake and says so.
        if ((response.status === 429 || response.status >= 500) && attempt < 4) {
            await Bun.sleep(1_000 * 2 ** attempt)
            return request(state, questions, attempt + 1)
        }
        if (!response.ok) throw new Error(`jev answered ${response.status}: ${await response.text()}`)
        const body = await response.json() as { answers?: Record<string, Answer>; usage?: { cost?: number } }
        if (!body.answers) throw new Error(`jev answered without answers: ${JSON.stringify(body).slice(0, 500)}`)
        const missing = Object.keys(questions).filter(id => !body.answers![id])
        if (missing.length > 0) throw new Error(`jev left ${missing.join(", ")} unanswered`)
        calls++
        cost += body.usage?.cost ?? 0
        return body.answers
    }
}

export type JevHandle = ReturnType<typeof Jev>

function hash(model: string, state: unknown, questions: unknown): string {
    return createHash("sha256").update(JSON.stringify([model, state, questions])).digest("hex").slice(0, 32)
}
