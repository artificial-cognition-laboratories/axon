import { existsSync, readdirSync, statSync } from "node:fs"
import { readFile, rename, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { err } from "@arcforge/err"
import type { StoreT } from "../../../services/store"
import { Frame } from "../../frame"
import { sessionHasEntries, sessionHead, type SessionRecord } from "./record"

type SessionsOpts = {
    store: StoreT
    /** Whether a session is live right now — the registry answers this, not the disk. */
    isRunning: (sessionId: string) => boolean
}

/**
 * Sessions — the resumable conversations on disk.
 *
 * Scans <agent>/.agent/data/sessions/*.jsonl directly: the filesystem is the
 * source of truth for "a session exists" (see core's home.ts), so there is no
 * registry to keep in sync. A session record exists whether or not anything is
 * running, which is why this is its own concern rather than a projection of the
 * instance registry — the registry only supplies the `running` flag.
 *
 * Reads the pre-migration location too. This scanner deliberately does NOT
 * boot a blueprint, so it cannot ask where an agent's data actually lives; it
 * has to know the convention. An agent that has not yet been re-prepared still
 * holds its history at the old path, and listing nothing for it would look
 * exactly like "this agent has never run" — a silent, total loss of visible
 * history rather than an error. Both paths are cheap to stat, so both are read.
 *
 * Still assumes the DEFAULT data path — an agent overriding blueprint
 * paths.data won't be listed; a deliberate cost of not booting a blueprint just
 * to enumerate logs.
 */
export function Sessions(opts: SessionsOpts) {
    /** Every on-disk session across the active profile's agents, newest first. */
    function list(): SessionRecord[] {
        const profile = opts.store.profiles.active()
        if (!profile) return []

        const records: SessionRecord[] = []
        const seen = new Set<string>()

        // locations(), not list(): every agent DIRECTORY in the canonical
        // store and in every settings.paths root, deduped by path. list()
        // dedupes by identity and lets a watched checkout shadow an installed
        // copy of the same name, which silently drops that copy's recorded
        // history — including, when it is the one running, the live session.
        for (const agent of profile.agents.locations()) {
            const agentRoot = agent.root
            const dirs = [
                join(Frame({ root: agentRoot, kind: "agent" }).path("data"), "sessions"),
                // Pre-migration. See this module's header.
                join(agentRoot, "data", "sessions"),
            ]

            for (const dir of dirs) {
                if (!existsSync(dir)) continue

                for (const file of readdirSync(dir)) {
                    if (!file.endsWith(".jsonl")) continue
                    const sessionId = basename(file, ".jsonl")

                    // A half-finished migration can leave the same session
                    // under both paths. It is one session either way, and
                    // the new location is authoritative because it is read
                    // first.
                    // Keyed by DIRECTORY, not name: two locations can
                    // share an identity (a checkout shadowing an install),
                    // and their logs are different conversations.
                    const key = `${agentRoot}/${sessionId}`
                    if (seen.has(key)) continue
                    seen.add(key)

                    const path = join(dir, file)
                    // One stat, one header read — both fields of each come
                    // off the same syscall rather than repeating it.
                    const stat = statSync(path)
                    const head = sessionHead(path)
                    records.push({
                        sessionId: sessionId,
                        agent: agent.name,
                        filePath: path,
                        modifiedAt: stat.mtimeMs,
                        sizeBytes: stat.size,
                        running: opts.isRunning(sessionId),
                        hasEntries: sessionHasEntries(path),
                        title: head.title,
                        forkedFrom: head.forkedFrom,
                    })
                }
            }
        }
        return records.sort((a, b) => b.modifiedAt - a.modifiedAt)
    }

    return {
        list,

        /**
         * The most recent conversation worth returning to — what `axon
         * --continue` resumes. Null when there is nothing to continue.
         *
         * ── Why `hasEntries` is the filter ──────────────────────────────────
         *
         * A session file exists from the moment an agent boots, before anyone
         * has said anything. Those empty logs are the MAJORITY of the newest
         * records on a machine where the TUI has been opened and closed a few
         * times, and resuming one restores nothing: the user sees an empty
         * chat, which is indistinguishable from `--continue` having failed
         * while looking exactly like it. "Latest session" and "latest
         * conversation" are different questions, and this answers the second.
         *
         * ── Profile-wide, not per-agent ─────────────────────────────────────
         *
         * "Continue what I was doing" is about the CONVERSATION; which agent
         * held it is a property of that conversation, not a separate choice
         * the user is making. The record carries its own agent, so resuming
         * brings the right one along without the caller selecting first.
         *
         * A running session is a legitimate answer — the caller focuses it
         * rather than double-spawning (see Instances.spawn, which refuses a
         * live sessionId). Excluding it here would skip past the conversation
         * the user most likely means.
         */
        latest(): SessionRecord | null {
            // list() is already newest-first, so the first match IS the latest.
            return list().find(record => record.hasEntries) ?? null
        },

        /**
         * Copy a session to a new one, and return the copy's id.
         *
         * ── Why a byte copy is the whole implementation ─────────────────────
         *
         * A session log is append-only JSONL and self-contained: every event
         * carries its own context, and nothing outside the file points into
         * it. So a fork is a copy with a rewritten header — no index to
         * update, no backend to tell, works offline, and works on a
         * deployment's local mirror. That is also why it is instant on a log
         * of any size a conversation produces.
         *
         * The events keep their ORIGINAL runIds and spanIds. They are
         * correlation ids within one log, not global identities, and
         * rewriting them would break nothing while making the copy diverge
         * from the record it is a copy of.
         *
         * ── Lineage is recorded now because it cannot be recovered later ────
         *
         * `forkedFrom` goes in the header at the one moment it is free to
         * know. Reconstructing it afterwards from timestamps and content
         * would be guesswork, and a fork with no parent is indistinguishable
         * from an ordinary session.
         */
        async fork(filePath: string, input: { title?: string } = {}): Promise<{ sessionId: string; filePath: string }> {
            if (!existsSync(filePath)) {
                throw err("SESSION_NOT_FOUND", { detail: filePath, context: { filePath } })
            }

            const source = await readFile(filePath, "utf-8")
            const newline = source.indexOf("\n")
            if (newline < 0) {
                throw err("SESSION_UNREADABLE", {
                    detail: `${filePath} has no header line`,
                    context: { filePath },
                })
            }

            let head: Record<string, unknown>
            try {
                head = JSON.parse(source.slice(0, newline)) as Record<string, unknown>
            } catch (cause) {
                throw err("SESSION_UNREADABLE", { detail: filePath, context: { filePath }, cause })
            }
            if (head.type !== "session:header") {
                throw err("SESSION_UNREADABLE", {
                    detail: `${filePath} does not start with a session:header`,
                    context: { filePath },
                })
            }

            const sessionId = crypto.randomUUID()
            const forked = {
                ...head,
                sessionId,
                startedAt: new Date().toISOString(),
                ...(input.title ? { title: input.title } : {}),
                forkedFrom: { sessionId: head.sessionId, at: new Date().toISOString() },
            }

            const target = join(dirname(filePath), `${sessionId}.jsonl`)
            // Written whole rather than appended: the copy has no reader yet,
            // so there is nothing to observe a partial write, and one write is
            // atomic enough for a file nothing is tailing.
            await writeFile(target, JSON.stringify(forked) + source.slice(newline))
            return { sessionId, filePath: target }
        },

        /**
         * Name a session, by rewriting its header's title.
         *
         * Same temp-then-rename dance `identify()` uses in @arcforge/session:
         * a reader tailing the log must never observe it half-written, and a
         * crash mid-write must not truncate it. Unlike identify(), this may run
         * against a large log — the rewrite is proportional to the file, which
         * is the price of keeping the name IN the log rather than beside it.
         */
        async rename(filePath: string, title: string): Promise<void> {
            if (!existsSync(filePath)) {
                throw err("SESSION_NOT_FOUND", { detail: filePath, context: { filePath } })
            }

            const current = await readFile(filePath, "utf-8")
            const newline = current.indexOf("\n")
            if (newline < 0) {
                throw err("SESSION_UNREADABLE", { detail: filePath, context: { filePath } })
            }

            let head: Record<string, unknown>
            try {
                head = JSON.parse(current.slice(0, newline)) as Record<string, unknown>
            } catch (cause) {
                throw err("SESSION_UNREADABLE", { detail: filePath, context: { filePath }, cause })
            }
            if (head.type !== "session:header") {
                throw err("SESSION_UNREADABLE", {
                    detail: `${filePath} does not start with a session:header`,
                    context: { filePath },
                })
            }

            const rewritten = JSON.stringify({ ...head, title }) + current.slice(newline)
            const tmp = `${filePath}.${Math.random().toString(36).slice(2, 10)}.tmp`
            await writeFile(tmp, rewritten)
            await rename(tmp, filePath)
        },
    }
}

export type SessionsT = ReturnType<typeof Sessions>
