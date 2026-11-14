import { createReadStream, existsSync } from "node:fs"
import { readdir, rm, stat } from "node:fs/promises"
import path from "node:path"
import { home } from "./home"

/**
 * How long a finished session is kept, and how much one agent's sessions may hold altogether.
 *
 * Three days, because a session is for looking at what just happened: an experiment is looked at the day it
 * ran, and anything worth keeping longer will be kept on purpose. Fifty gigabytes, because a minute of an
 * embodied mind is a few hundred megabytes of frames and telemetry, and a busy day must not fill a disk.
 */
export const RETENTION = { days: 3, bytes: 50 * 1024 ** 3 }

/** A session written to this recently may still be running, in this process or another: it is never removed. */
const RUNNING_MS = 5 * 60 * 1000

/**
 * What anything said looks like on a log: text in (a person's message, a job's brief) or text out (the agent
 * answering). Either makes the session a conversation: measured (2026-10-07), Zeno's busiest sessions hold
 * hundreds of answers and not one text stimulus — what it is told does not always arrive as one.
 */
const CONVERSATION = ['"type":"cognet:stimulus:text"', '"type":"cognet:output:text"']

/** One session, as retention sees it. */
export type Held = {
    id: string
    /** When any part of it was last written, ms. */
    written: number
    bytes: number
    /** Whether anything was said in it — its log is then the conversation, and is never removed by age or budget. */
    conversation: boolean
}

/** What a sweep removes: whole sessions, or — for a conversation — everything but its log. */
export type Going = Held & { why: "age" | "budget"; freed: number }

export type Plan = { going: Going[]; kept: number; bytes: number }

/**
 * Retention — the one rule for how long an agent's sessions are kept: every
 * part of every session at full fidelity — its log, its senses, telemetry and
 * frames, the debugger's index of it — for `days` after it was last written,
 * and while all of them together fit in `bytes`; past that, oldest first.
 *
 * A conversation is the exception, and only its log is: for an agent a person
 * talks to, the log IS the conversation, which `--continue` resumes, and no
 * rule about disk space may quietly delete what somebody said. Its windows go
 * like any other session's.
 *
 * Applied when a session opens (`session.ts`) and by `axon debug prune`, so the
 * rule that runs on its own and the one a person runs are the same rule.
 */
export function Retention(opts: { root: string }) {
    /** Every path one session's data lives at. */
    function parts(id: string): { log: string; windows: string[] } {
        return {
            log: home.data.sessions.path(opts.root, id),
            windows: [
                home.data.sensory.dir(opts.root, id),
                home.data.telemetry.dir(opts.root, id),
                home.data.media.dir(opts.root, id),
                // The debugger's index of the session (`axon debug`): derived from it, and nothing without it.
                path.join(opts.root, "debug", `${id}.json`),
            ],
        }
    }

    /** Every session with anything on disk — a log, or windows whose log is already gone. */
    async function ids(): Promise<string[]> {
        const found = new Set<string>()
        const logs = path.join(opts.root, "sessions")
        if (existsSync(logs)) for (const name of await readdir(logs)) if (name.endsWith(".jsonl")) found.add(name.slice(0, -".jsonl".length))
        for (const kind of ["sensory", "telemetry", "media"]) {
            const dir = path.join(opts.root, kind)
            if (!existsSync(dir)) continue
            for (const entry of await readdir(dir, { withFileTypes: true })) if (entry.isDirectory()) found.add(entry.name)
        }
        return [...found]
    }

    async function held(id: string): Promise<Held & { log: number }> {
        const { log, windows } = parts(id)
        let written = 0
        let bytes = 0
        let logBytes = 0
        for (const part of [log, ...windows]) {
            const measured = await measure(part)
            written = Math.max(written, measured.written)
            bytes += measured.bytes
            if (part === log) logBytes = measured.bytes
        }
        return { id: id, written: written, bytes: bytes, log: logBytes, conversation: logBytes > 0 && await contains(log, CONVERSATION) }
    }

    return {
        /** What the rule would remove now. `current` — the session opening — is never among it. */
        async plan(input: { now: number; current?: string; days?: number; bytes?: number }): Promise<Plan> {
            const days = input.days ?? RETENTION.days
            const budget = input.bytes ?? RETENTION.bytes
            const all = (await Promise.all((await ids()).map(held))).sort((a, b) => b.written - a.written)
            const going: Going[] = []
            let total = all.reduce((sum, session) => sum + session.bytes, 0)
            // Oldest first, so the budget takes the oldest of what age left behind.
            for (const session of [...all].reverse()) {
                if (session.id === input.current || input.now - session.written < RUNNING_MS) continue
                const why = input.now - session.written > days * 24 * 60 * 60 * 1000 ? "age" : total > budget ? "budget" : null
                if (!why) continue
                const freed = session.conversation ? session.bytes - session.log : session.bytes
                if (freed === 0) continue
                const { log: _log, ...rest } = session
                going.push({ ...rest, why: why, freed: freed })
                total -= freed
            }
            return { going: going, kept: all.length - going.filter(session => !session.conversation).length, bytes: total }
        },

        /** Removes what `plan` said would go. */
        async apply(plan: Plan): Promise<void> {
            for (const session of plan.going) {
                const { log, windows } = parts(session.id)
                for (const part of session.conversation ? windows : [log, ...windows]) await rm(part, { recursive: true, force: true })
            }
        },
    }
}

export type RetentionT = ReturnType<typeof Retention>

/** The bytes under a path and when it was last written; nothing for a path that is not there. */
async function measure(target: string): Promise<{ bytes: number; written: number }> {
    if (!existsSync(target)) return { bytes: 0, written: 0 }
    const info = await stat(target)
    if (!info.isDirectory()) return { bytes: info.size, written: info.mtimeMs }
    let bytes = 0
    let written = info.mtimeMs
    for (const name of await readdir(target)) {
        const inner = await measure(path.join(target, name))
        bytes += inner.bytes
        written = Math.max(written, inner.written)
    }
    return { bytes: bytes, written: written }
}

/** Whether `file` holds any of `texts`, read as a stream — a log can be gigabytes, and is never held whole. */
async function contains(file: string, texts: readonly string[]): Promise<boolean> {
    const longest = Math.max(...texts.map(text => text.length))
    // Node's stream, not Bun's: this package is also loaded by the editor's extension host.
    let carried = ""
    for await (const chunk of createReadStream(file, { encoding: "utf-8", highWaterMark: 1024 * 1024 })) {
        const piece = carried + String(chunk)
        if (texts.some(text => piece.includes(text))) return true
        carried = piece.slice(-longest)
    }
    return false
}
