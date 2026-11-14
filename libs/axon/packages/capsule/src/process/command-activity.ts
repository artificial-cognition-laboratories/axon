import { isShellCommand, programName, splitCommand } from "@arcforge/types"
import type { ActivityHandle, ActivityType } from "@arcforge/types"
import type { ActivitiesT } from "./activities"

/**
 * CommandActivity — the display fact for one `process.run()` invocation.
 *
 * Every command gets a row immediately. Simple commands are upgraded to a
 * semantic filesystem, VCS or HTTP action; compound shell programs stay a
 * truthful `proc:exec` rather than being guessed apart by a partial parser.
 */
export function CommandActivity(opts: { activities: ActivitiesT }) {
    function open(command: string) {
        const classified = classifyCommand(command)
        if (classified.type === "proc:exec") {
            const activity = opts.activities.activity("proc:exec", { command: command, startedAt: Date.now() })
            return OutputActivity(activity)
        }
        return { ...opts.activities.activity(classified.type, classified.data), output: null }
    }

    function spawn(command: string, procId: string) {
        // A managed process deliberately outlives the short script that
        // created it. Its activity must therefore settle on CHILD exit, not
        // command completion; otherwise the TUI collapses the live work card
        // while the process is still doing the work the user is waiting on.
        const activity = opts.activities.activity("proc:spawn", { command: command, procId: procId, startedAt: Date.now() }, { autoSettle: false })
        return OutputActivity(activity)
    }

    function kill(procId: string, command?: string): ActivityHandle<"proc:kill"> {
        return opts.activities.activity("proc:kill", { procId: procId, ...(command ? { command: command } : {}) })
    }

    return { open, spawn, kill }
}

export type CommandActivityT = ReturnType<typeof CommandActivity>

/** Bound output telemetry to one update per second; final bytes arrive on settle. */
function OutputActivity(activity: ActivityHandle<"proc:exec" | "proc:spawn">) {
    let outputBytes = 0
    let lastReport = Date.now()
    return {
        update: activity.update,
        output(chunk: string): void {
            outputBytes += Buffer.byteLength(chunk)
            const now = Date.now()
            if (now - lastReport < 1000) return
            lastReport = now
            activity.update({ outputBytes: outputBytes })
        },
        done(data: { exitCode?: number; stopped?: boolean } = {}): void {
            activity.done({ ...data, outputBytes: outputBytes })
        },
        fail(data: { exitCode?: number; procId?: string }, error: string): void {
            activity.fail({ ...data, outputBytes: outputBytes }, error)
        },
    }
}

export function classifyCommand(command: string): { type: ActivityType; data: Record<string, unknown> } {
    const trimmed = command.trim()
    if (trimmed.length === 0 || isShellCommand(trimmed)) return { type: "proc:exec", data: { command: trimmed } }

    const argv = splitCommand(trimmed)
    const program = programName(argv[0] ?? "")
    const args = argv.slice(1)
    const positional = args.filter(arg => !arg.startsWith("-"))

    if (program === "rg" || program === "grep" || program === "ag" || program === "ack") {
        const query = positional[0]
        if (query) return { type: "file:search", data: { query, ...(positional[1] ? { scope: positional.at(-1) } : {}) } }
    }
    if (program === "find") return { type: "file:search", data: { query: args.slice(1).join(" ") || "*", scope: args[0] ?? "." } }
    if (["cat", "head", "tail", "sed", "awk"].includes(program)) {
        const path = positional.at(-1)
        if (program === "sed" && args.some(arg => arg === "-i" || arg.startsWith("-i")) && path && !path.includes("*")) {
            return { type: "file:patch", data: { path } }
        }
        if (path && !path.includes("*")) return { type: "file:read", data: { path } }
    }
    if (["ls", "tree", "fd"].includes(program)) return { type: "file:list", data: { path: positional.at(-1) ?? "." } }
    if (program === "mkdir" || program === "touch" || program === "tee") {
        const path = positional.at(-1)
        if (path && !path.includes("*")) return { type: "file:write", data: { path } }
    }
    if (program === "rm" || program === "rmdir") {
        const path = positional.at(-1)
        if (path && !path.includes("*")) return { type: "file:delete", data: { path } }
    }
    if (program === "mv" && positional.length === 2) return { type: "file:move", data: { from: positional[0], to: positional[1] } }
    if (program === "cp" && positional.length === 2) return { type: "file:write", data: { path: positional[1] } }
    if (program === "git") {
        const subcommand = args.find(arg => !arg.startsWith("-"))
        const detail = args.join(" ")
        if (subcommand === "status") return { type: "vcs:status", data: {} }
        if (subcommand === "diff") return { type: "vcs:diff", data: { ...(detail ? { args: detail } : {}) } }
        if (subcommand === "log") return { type: "vcs:log", data: { ...(detail ? { args: detail } : {}) } }
        if (subcommand === "show") return { type: "vcs:show", data: { ...(detail ? { args: detail } : {}) } }
    }
    if (program === "curl" || program === "wget") {
        const url = positional.find(arg => /^https?:\/\//.test(arg))
        if (url) {
            const at = args.findIndex(arg => arg === "-X" || arg === "--request")
            const method = at >= 0 ? args[at + 1] ?? "GET" : "GET"
            return { type: "http", data: { method, url } }
        }
    }
    return { type: "proc:exec", data: { command: trimmed } }
}
