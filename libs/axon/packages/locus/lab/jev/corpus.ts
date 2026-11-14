import { readFileSync } from "node:fs"
import { join, relative } from "node:path"
import type { RngHandle } from "../rng"

/** One thing a person said to an agent, as the session recorded it. */
export type Message = {
    id: string
    /** The agent it was said to. */
    agent: string
    /** When, in ms. */
    at: number
    text: string
}

/**
 * Corpus — what people actually said to the agents in this repo: every
 * `cognet:stimulus:text` in every session under a `.agent/data/sessions`.
 *
 * Real requests, reactions and corrections, which is what a coding mind's
 * memory will be made of. Duplicates are dropped (the same prompt re-sent is
 * one thing), and so is anything too short to say anything.
 */
export function Corpus(opts: { root: string; minLength: number; maxLength: number }) {
    return {
        /** Every distinct message, oldest first. */
        all(): Message[] {
            const seen = new Set<string>()
            const messages: Message[] = []
            const sessions = new Bun.Glob("**/.agent/data/sessions/*.jsonl")
            for (const path of sessions.scanSync({ cwd: opts.root, dot: true })) {
                if (path.includes("node_modules")) continue
                const agent = agentOf(path)
                for (const line of readFileSync(join(opts.root, path), "utf8").split("\n")) {
                    if (!line.includes(`"cognet:stimulus:text"`)) continue
                    const event = JSON.parse(line) as { type: string; time: { ms: number }; data: { content?: string } }
                    const text = event.data.content?.trim()
                    if (event.type !== "cognet:stimulus:text" || !text || text.length < opts.minLength || seen.has(text)) continue
                    seen.add(text)
                    messages.push({ id: `m${messages.length}`, agent: agent, at: event.time.ms, text: text.slice(0, opts.maxLength) })
                }
            }
            return messages.sort((a, b) => a.at - b.at)
        },

        /** `count` of them, chosen by the seed — the same seed, the same sample. */
        sample(count: number, rng: RngHandle): Message[] {
            const all = this.all()
            for (let i = all.length - 1; i > 0; i--) {
                const j = rng.int(i + 1)
                ;[all[i], all[j]] = [all[j]!, all[i]!]
            }
            return all.slice(0, count)
        },
    }

    /** `registry/agents/zeno/.agent/data/…` → `zeno`; the repo's own `.agent` → `arclabs`. */
    function agentOf(path: string): string {
        const parts = relative(opts.root, join(opts.root, path)).split("/")
        const at = parts.indexOf(".agent")
        return at > 0 ? parts[at - 1]! : "arclabs"
    }
}
