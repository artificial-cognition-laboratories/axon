import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { isValidCron, matches, nextRun } from "./cron"

export type ScheduleTarget = {
    /** Registry identity of the agent blueprint. */
    agent: string
    /** Absolute checkout root used to execute the wakeup. */
    projectRoot: string
    /** Five-field cron expression, evaluated in local time. */
    every: string
    /** Named prompt, or null when this is script-only. */
    prompt: string | null
    /** Named script, or null when this is prompt-only. */
    script: string | null
    /** Arguments passed to the script when present. */
    args: Record<string, string>
}

export type ScheduleResult = {
    status: "succeeded" | "failed" | "skipped"
    sessionId?: string
    message?: string
}

export type AgentSchedule = ScheduleTarget & {
    id: string
    paused: boolean
    createdAt: string
    updatedAt: string
    lastRunAt: string | null
    lastResult: ScheduleResult | null
    error?: string
}

export type CreateSchedule = ScheduleTarget & {
    paused?: boolean
}

export type UpdateSchedule = Partial<Omit<ScheduleTarget, "agent" | "projectRoot">> & {
    paused?: boolean
}

export type ScheduleState = {
    schedules: AgentSchedule[]
    running: boolean
    nextRunAt: string | null
}

/**
 * Durable schedule store.
 *
 * One file per schedule means a malformed entry can remain visible without
 * preventing every other schedule from loading. The daemon owns this state;
 * Fleet is only a client of these verbs.
 */
type ScheduleOpts = {
    root: string
    /** Runs one due wakeup through the daemon's supervised execution path. */
    execute?: (schedule: AgentSchedule) => Promise<ScheduleResult>
    /** Clock seam for deterministic scheduler tests. */
    now?: () => number
}

export function Schedule(opts: ScheduleOpts) {
    const directory = join(opts.root, "schedules")
    let running = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const now = opts.now ?? (() => Date.now())
    const inFlight = new Set<string>()

    function ensureDirectory(): void {
        mkdirSync(directory, { recursive: true })
    }

    function file(id: string): string {
        return join(directory, `${id}.json`)
    }

    function readOne(path: string): AgentSchedule {
        const value = JSON.parse(readFileSync(path, "utf8")) as Partial<AgentSchedule>
        if (typeof value.id !== "string" || !value.id) throw new Error("schedule id is required")
        if (typeof value.agent !== "string" || !value.agent) throw new Error("schedule agent is required")
        if (typeof value.projectRoot !== "string" || !value.projectRoot) throw new Error("schedule projectRoot is required")
        if (typeof value.every !== "string" || !isValidCron(value.every)) throw new Error("schedule every must be five-field cron")
        if (value.prompt !== null && value.prompt !== undefined && typeof value.prompt !== "string") throw new Error("schedule prompt must be a string or null")
        if (value.script !== null && value.script !== undefined && typeof value.script !== "string") throw new Error("schedule script must be a string or null")
        const prompt = value.prompt ?? null
        const script = value.script ?? null
        if (!prompt && !script) throw new Error("schedule requires a prompt or script")
        return {
            id: value.id,
            agent: value.agent,
            projectRoot: value.projectRoot,
            every: value.every,
            prompt,
            script,
            args: value.args && typeof value.args === "object" ? value.args : {},
            paused: value.paused === true,
            createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date(0).toISOString(),
            updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date(0).toISOString(),
            lastRunAt: typeof value.lastRunAt === "string" ? value.lastRunAt : null,
            lastResult: value.lastResult && typeof value.lastResult === "object" ? value.lastResult : null,
            ...(typeof value.error === "string" ? { error: value.error } : {}),
        }
    }

    function readAll(): AgentSchedule[] {
        if (!existsSync(directory)) return []
        const entries: AgentSchedule[] = []
        for (const name of readdirSync(directory)) {
            if (!name.endsWith(".json")) continue
            const path = join(directory, name)
            try {
                entries.push(readOne(path))
            } catch (cause) {
                const id = name.slice(0, -5)
                entries.push({
                    id,
                    agent: "unknown",
                    projectRoot: "",
                    every: "* * * * *",
                    prompt: null,
                    script: null,
                    args: {},
                    paused: true,
                    createdAt: new Date(0).toISOString(),
                    updatedAt: new Date(0).toISOString(),
                    lastRunAt: null,
                    lastResult: { status: "failed", message: cause instanceof Error ? cause.message : String(cause) },
                    error: cause instanceof Error ? cause.message : String(cause),
                })
            }
        }
        return entries.sort((a, b) => a.id.localeCompare(b.id))
    }

    function write(value: AgentSchedule): AgentSchedule {
        ensureDirectory()
        const destination = file(value.id)
        const temporary = `${destination}.${process.pid}.tmp`
        writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", "utf8")
        renameSync(temporary, destination)
        return value
    }

    function validate(input: ScheduleTarget): void {
        if (!input.agent.trim()) throw new Error("schedule agent is required")
        if (!input.projectRoot.trim()) throw new Error("schedule projectRoot is required")
        if (!isValidCron(input.every)) throw new Error("schedule every must be five-field cron")
        if (!input.prompt && !input.script) throw new Error("schedule requires a prompt or script")
        if (input.prompt !== null && typeof input.prompt !== "string") throw new Error("schedule prompt must be a string or null")
        if (input.script !== null && typeof input.script !== "string") throw new Error("schedule script must be a string or null")
    }

    function create(input: CreateSchedule): AgentSchedule {
        validate(input)
        const now = new Date().toISOString()
        return write({
            ...input,
            prompt: input.prompt || null,
            script: input.script || null,
            args: { ...input.args },
            id: randomUUID(),
            paused: input.paused === true,
            createdAt: now,
            updatedAt: now,
            lastRunAt: null,
            lastResult: null,
        })
    }

    function get(id: string): AgentSchedule {
        const found = readAll().find(entry => entry.id === id)
        if (!found) throw new Error(`schedule not found: ${id}`)
        return found
    }

    function update(id: string, patch: UpdateSchedule): AgentSchedule {
        const current = get(id)
        const next = {
            ...current,
            ...patch,
            prompt: patch.prompt === undefined ? current.prompt : patch.prompt || null,
            script: patch.script === undefined ? current.script : patch.script || null,
            args: patch.args === undefined ? current.args : { ...patch.args },
            updatedAt: new Date().toISOString(),
        }
        validate(next)
        return write(next)
    }

    function remove(id: string): boolean {
        const path = file(id)
        if (!existsSync(path)) return false
        rmSync(path, { force: true })
        return true
    }

    function pause(id: string): AgentSchedule {
        return update(id, { paused: true })
    }

    function resume(id: string): AgentSchedule {
        return update(id, { paused: false })
    }

    function nextOccurrence(schedules: AgentSchedule[] = readAll()): number | null {
        const times = schedules
            .filter(entry => !entry.paused && !entry.error)
            .map(entry => nextRun(entry.every, entry.lastRunAt ? Date.parse(entry.lastRunAt) : now()))
            .filter((value): value is number => value !== null)
        return times.length ? Math.min(...times) : null
    }

    function state(): ScheduleState {
        const schedules = readAll()
        const at = nextOccurrence(schedules)
        return {
            schedules,
            running,
            nextRunAt: at === null ? null : new Date(at).toISOString(),
        }
    }

    /**
     * Record that an occurrence was consumed, and later how it went.
     *
     * These existed ONLY as methods on the returned handle, while `fire()` and
     * `runNow()` — the two functions that drive every scheduled run — called
     * them as bare closure functions. Nothing in the closure was ever bound to
     * those names, so the first line of the first scheduled run threw
     * `ReferenceError: markStarted is not defined`, in a `void fire(entry)`
     * with no catch above it. Eight call sites, none reachable without
     * throwing: scheduled execution has never run.
     *
     * Declared here and referenced by the handle, rather than the reverse, so
     * there is one definition and the internal callers cannot drift from the
     * exposed ones again.
     */
    function markStarted(id: string, at = new Date().toISOString()): AgentSchedule {
        const current = get(id)
        return write({ ...current, lastRunAt: at, updatedAt: new Date().toISOString() })
    }

    function markFinished(id: string, result: ScheduleResult): AgentSchedule {
        const current = get(id)
        return write({ ...current, lastResult: result, updatedAt: new Date().toISOString() })
    }

    async function fire(entry: AgentSchedule): Promise<void> {
        if (entry.paused || entry.error || inFlight.has(entry.id)) return
        inFlight.add(entry.id)
        // Consume the occurrence before execution. A daemon crash after this
        // point must not replay the same minute when it restarts.
        const started = markStarted(entry.id, new Date(now()).toISOString())
        try {
            if (!opts.execute) {
                markFinished(entry.id, { status: "skipped", message: "schedule execution is not wired" })
                return
            }
            const result = await opts.execute(started)
            markFinished(entry.id, result)
        } catch (cause) {
            markFinished(entry.id, {
                status: "failed",
                message: cause instanceof Error ? cause.message : String(cause),
            })
        } finally {
            inFlight.delete(entry.id)
            arm()
        }
    }

    function tick(): void {
        if (!running) return
        const current = new Date(now())
        for (const entry of readAll()) {
            if (entry.paused || entry.error || inFlight.has(entry.id)) continue
            const last = entry.lastRunAt ? Date.parse(entry.lastRunAt) : 0
            if (matches(entry.every, current) && last < current.getTime() - (current.getSeconds() * 1000)) {
                void fire(entry)
            }
        }
        arm()
    }

    function arm(): void {
        if (!running) return
        if (timer) clearTimeout(timer)
        const at = nextOccurrence()
        const delay = at === null ? 60_000 : Math.max(250, at - now())
        timer = setTimeout(tick, delay)
    }

    async function runNow(id: string): Promise<ScheduleResult> {
        const entry = get(id)
        if (entry.paused) return { status: "skipped", message: "schedule is paused" }
        if (inFlight.has(id)) return { status: "skipped", message: "schedule is already running" }
        inFlight.add(id)
        const started = markStarted(id, new Date(now()).toISOString())
        try {
            if (!opts.execute) {
                const result = { status: "skipped" as const, message: "schedule execution is not wired" }
                markFinished(id, result)
                return result
            }
            const result = await opts.execute(started)
            markFinished(id, result)
            return result
        } catch (cause) {
            const result = { status: "failed" as const, message: cause instanceof Error ? cause.message : String(cause) }
            markFinished(id, result)
            return result
        } finally {
            inFlight.delete(id)
            arm()
        }
    }

    return {
        list(agent?: string): AgentSchedule[] {
            return readAll().filter(entry => !agent || entry.agent === agent)
        },
        state,
        create,
        update,
        remove,
        pause,
        resume,
        runNow,
        /** Internal lifecycle hooks used by the daemon execution loop. */
        markStarted,
        markFinished,
        start(): void {
            if (running) return
            running = true
            arm()
        },
        stop(): void {
            running = false
            if (timer) clearTimeout(timer)
            timer = undefined
        },
    }
}

export type ScheduleT = ReturnType<typeof Schedule>
