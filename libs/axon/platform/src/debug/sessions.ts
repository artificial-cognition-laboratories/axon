import { existsSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { err } from "@arcforge/err"
import { home, Retention } from "@arcforge/session"
import { Frame } from "../build/frame"
import type { Found, Sizes } from "./types"

/**
 * Sessions — finds an agent's sessions on disk, names one, says how much
 * each holds, and removes what is no longer wanted.
 */
export function Sessions() {
    /** Where an agent keeps its data. */
    function data(agent: string): string {
        return Frame({ root: agent, kind: "agent" }).path("data")
    }

    /** Where a session's index is kept — beside the data, apart from the sessions so nothing lists it as one. */
    function index(agent: string, id: string): string {
        return join(data(agent), "debug", `${id}.json`)
    }

    /** Every session, newest first. */
    function list(agent: string): Found[] {
        const dir = join(data(agent), "sessions")
        if (!existsSync(dir)) return []
        return readdirSync(dir)
            .filter(name => name.endsWith(".jsonl"))
            .map(name => ({ id: name.slice(0, -".jsonl".length), file: join(dir, name), modifiedAt: statSync(join(dir, name)).mtimeMs }))
            .sort((a, b) => b.modifiedAt - a.modifiedAt)
    }

    function sizes(agent: string, id: string): Sizes {
        const root = data(agent)
        const log = bytes(home.data.sessions.path(root, id))
        const telemetry = bytes(home.data.telemetry.dir(root, id))
        const sensory = bytes(home.data.sensory.dir(root, id))
        const media = bytes(home.data.media.dir(root, id))
        return { log: log, telemetry: telemetry, sensory: sensory, media: media, total: log + telemetry + sensory + media }
    }

    return {
        data: data,
        index: index,
        list: list,
        sizes: sizes,

        /** The session a reference names: `latest`, an id, or any prefix of one that only one session has. */
        resolve(agent: string, ref: string): Found {
            const all = list(agent)
            if (ref === "latest") {
                if (!all[0]) throw err("SESSION_NOT_FOUND", { detail: `${agent} has no sessions` })
                return all[0]
            }
            if (ref === "live") throw err("DEBUG_NOT_WIRED", { detail: "`live` is not wired yet — a running session's files are read the same way, so name it `latest`" })
            const matching = all.filter(session => session.id.startsWith(ref))
            if (matching.length === 0) throw err("SESSION_NOT_FOUND", { detail: `no session of ${agent} starts with "${ref}"` })
            if (matching.length > 1) throw err("DEBUG_AMBIGUOUS", { detail: `"${ref}" names ${matching.length} sessions: ${matching.slice(0, 5).map(session => session.id).join(", ")}` })
            return matching[0]!
        },

        /**
         * What the retention rule removes now — the rule every session already
         * applies as it opens (see Retention in @arcforge/session) — and, with
         * `apply`, removing it. `days` and `gb` tighten or loosen the rule for
         * this one prune.
         */
        async prune(agent: string, rule: { days?: number; gb?: number; apply: boolean }, now: number): Promise<{ removed: Array<{ id: string; bytes: number; why: "age" | "budget"; conversation: boolean }>; bytes: number; kept: number; remaining: number }> {
            const retention = Retention({ root: data(agent) })
            const plan = await retention.plan({ now: now, ...(rule.days !== undefined ? { days: rule.days } : {}), ...(rule.gb !== undefined ? { bytes: rule.gb * 1024 ** 3 } : {}) })
            if (rule.apply) await retention.apply(plan)
            return {
                removed: plan.going.map(going => ({ id: going.id, bytes: going.freed, why: going.why, conversation: going.conversation })),
                bytes: plan.going.reduce((sum, going) => sum + going.freed, 0),
                kept: plan.kept,
                remaining: plan.bytes,
            }
        },
    }
}

export type SessionsT = ReturnType<typeof Sessions>

/** Bytes under a path: a file's own, or everything beneath a directory. Nothing for a path that is not there. */
function bytes(path: string): number {
    if (!existsSync(path)) return 0
    const stat = statSync(path)
    if (!stat.isDirectory()) return stat.size
    return readdirSync(path).reduce((sum, name) => sum + bytes(join(path, name)), 0)
}
