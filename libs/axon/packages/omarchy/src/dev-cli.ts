/**
 * The daemon's command verbs, straight from source.
 *
 * The development twin of `dev-watch.ts`, and it exists for the same reason:
 * the published CLI is what a user runs, and a checkout working on the daemon
 * has neither that version nor its path. Point the service at it with the
 * plugin's `commandPrefix` setting.
 *
 * Argument handling mirrors `axon daemon <verb> …` exactly, so what is
 * exercised here is what ships.
 */
import { writeSync } from "node:fs"
import { Axond } from "../../axond/src/axond"
import { Cli } from "../../axond/src/control/cli"

const argv = process.argv.slice(2)
const json = argv.includes("--json")
const page = argv.includes("--more")
const capabilityAt = argv.indexOf("--capability")
const capability = capabilityAt === -1 ? undefined : argv[capabilityAt + 1]
const sortAt = argv.indexOf("--sort")
const sort = sortAt === -1 ? undefined : argv[sortAt + 1]
const fitsOnly = argv.includes("--fits")
// `-p` carries free text, so it is extracted as a value flag rather than left
// among the positionals — a prompt with a space in it is every prompt.
const promptAt = argv.findIndex(arg => arg === "-p" || arg === "--prompt")
const prompt = promptAt === -1 ? undefined : argv[promptAt + 1]
// Guarded: with no `--capability` the index is -1, so `+ 1` is 0 and an
// unguarded comparison drops argv[0] — the verb itself.
const values = new Set([capabilityAt, sortAt, promptAt].filter(at => at !== -1).map(at => at + 1))
const flags = new Set(["--json", "--more", "--fits", "--capability", "--sort", "-p", "--prompt"])
const filtered = argv.filter((arg, at) => !flags.has(arg) && !values.has(at))
const [verb, ...rest] = filtered

/**
 * Write every byte to a file descriptor before returning.
 *
 * `console.log` and `Bun.write` are buffered and `process.exit` after either
 * truncates — but so does a bare `writeSync`, because a pipe accepts only what
 * fits in its 64KB buffer and returns how much it took. A paged catalogue
 * crosses that on its third page, and the consumer received invalid JSON with
 * nothing to say why. The exit cannot simply be dropped: the daemon handle
 * keeps the event loop alive.
 */
function writeAll(fd: number, text: string): void {
    const bytes = Buffer.from(text, "utf-8")
    let written = 0
    while (written < bytes.length) {
        try {
            written += writeSync(fd, bytes, written, bytes.length - written)
        } catch (cause) {
            // The reader has not drained yet. Retrying is correct; anything
            // else loses the tail, which is the whole failure being fixed.
            if ((cause as { code?: string }).code !== "EAGAIN") throw cause
        }
    }
}

const axond = Axond({})
const cli = Cli({ axond }) as unknown as Record<string, (...args: unknown[]) => unknown>

if (!verb || typeof cli[verb] !== "function") {
    console.error(`unknown daemon verb: ${verb ?? "(none)"}`)
    process.exit(2)
}

/**
 * Verbs whose first parameter is a value, so a missing one must stay
 * `undefined` rather than sliding the json flag into its place. `budget` with
 * no argument READS; passing `true` there made it try to parse "true" as a
 * size.
 */
const VALUE_FIRST = new Set(["budget", "boot", "autoload", "remove", "unload", "pin", "job", "jobSay", "jobDone", "jobCancel", "jobRetry", "fetch", "model", "download", "cancelDownload"])

/**
 * Verbs taking TWO values before the json flag, not one.
 *
 * `fetch` and `download` are `(specifier, file, json)`. Treating them as
 * one-value verbs slid `true` into `file`, and the daemon dutifully asked the
 * registry for a weight named "true" — the same shape of mistake as passing
 * the flag to `budget` and watching it try to parse "true" as a size.
 */
const TWO_VALUES = new Set(["fetch", "download", "jobSay"])

try {
    let out: unknown
    if (verb === "catalog") {
        out = await cli.catalog!(rest.join(" "), capability, json, page, sort, fitsOnly)
    } else if (verb === "jobs") {
        // `jobs(all, json)` — its first parameter is a SWITCH, so the default
        // branch's `cli[verb](json)` would slide the json flag into it and
        // leave the output mode undefined. Same shape of bug VALUE_FIRST
        // exists to prevent, one slot to the left.
        out = await cli.jobs!(argv.includes("--all"), json)
    } else if (verb === "jobCreate") {
        // Its first parameter is an OBJECT, not a value — the only verb here
        // shaped that way, because `axon job create` carries four optional
        // fields and positional slots for them would be unreadable.
        out = await cli.jobCreate!({ content: rest.join(" ") }, json)
    } else if (verb === "run") {
        // `(model, input, json)` — the input arrives as `-p`, or as whatever
        // positionals follow the model.
        out = await cli.run!(rest[0], prompt ?? rest.slice(1).join(" "), json)
    } else if (VALUE_FIRST.has(verb)) {
        out = await cli[verb]!(rest[0], ...(TWO_VALUES.has(verb) ? [rest[1]] : []), json)
    } else {
        out = await cli[verb]!(json)
    }
    writeAll(1, String(out) + "\n")
    process.exit(0)
} catch (cause) {
    writeAll(2, (cause instanceof Error ? cause.message : String(cause)) + "\n")
    process.exit(1)
}
