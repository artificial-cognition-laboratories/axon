import { readFileSync } from "node:fs"
import { join } from "node:path"

/** Who an atom came from: the person, the agent's prose, or code the agent ran. */
export type Speaker = "person" | "agent" | "action"

/** The smallest piece of a session worth linking: one sentence, one line, one action. */
export type Atom = {
    session: string
    agent: string
    /** Its place in the session, in order. */
    index: number
    speaker: Speaker
    text: string
}

/**
 * Atoms — every session in the repo, split mechanically into atoms, in order.
 *
 * No model: a person's message and the agent's prose split into sentences and
 * lines; each piece of code the agent ran is one atom whole, since splitting
 * code by sentence means nothing. The agent's prose arrives streamed in pieces
 * and is joined back into its whole text first.
 */
export function Atoms(opts: { root: string; minLength: number; maxLength: number }) {
    return {
        /** Each session's atoms, in the order they happened. */
        sessions(): Atom[][] {
            const sessions: Atom[][] = []
            for (const path of new Bun.Glob("**/.agent/data/sessions/*.jsonl").scanSync({ cwd: opts.root, dot: true })) {
                if (path.includes("node_modules")) continue
                const atoms = read(path)
                if (atoms.length > 0) sessions.push(atoms)
            }
            return sessions
        },
    }

    function read(path: string): Atom[] {
        const session = path.split("/").at(-1)!.replace(".jsonl", "")
        const parts = path.split("/")
        const agent = parts.indexOf(".agent") > 0 ? parts[parts.indexOf(".agent") - 1]! : "arclabs"
        const pieces: Array<{ speaker: Speaker; text: string }> = []
        /** The agent's streamed prose, by the chunk it belongs to, until the chunk is done. */
        const streamed = new Map<string, string>()
        const flush = () => {
            for (const text of streamed.values()) pieces.push({ speaker: "agent", text: text })
            streamed.clear()
        }
        for (const line of readFileSync(join(opts.root, path), "utf8").split("\n")) {
            if (!line.includes(`"cognet:stimulus:text"`) && !line.includes(`"cognet:output:text"`) && !line.includes(`"cognet:action:typescript"`)) continue
            const event = JSON.parse(line) as { type: string; data: { content?: string; type?: string; chunk?: { of: string } } }
            if (event.type === "cognet:output:text" && event.data.type === "engine:text" && event.data.chunk) {
                streamed.set(event.data.chunk.of, (streamed.get(event.data.chunk.of) ?? "") + (event.data.content ?? ""))
                continue
            }
            flush()
            if (event.type === "cognet:stimulus:text" && event.data.content) pieces.push({ speaker: "person", text: event.data.content })
            if (event.type === "cognet:action:typescript" && event.data.content) pieces.push({ speaker: "action", text: event.data.content })
        }
        flush()

        const atoms: Atom[] = []
        for (const piece of pieces) {
            const split = piece.speaker === "action" ? [piece.text] : sentences(piece.text)
            for (const text of split) {
                const trimmed = text.trim()
                if (trimmed.length < opts.minLength) continue
                atoms.push({ session: session, agent: agent, index: atoms.length, speaker: piece.speaker, text: trimmed.slice(0, opts.maxLength) })
            }
        }
        return atoms
    }
}

/** Prose into sentences and lines — a line break is a boundary as surely as a full stop. */
function sentences(text: string): string[] {
    return text.split(/\n+/).flatMap(line => line.split(/(?<=[.!?])\s+(?=[A-Z`"'(])/))
}
