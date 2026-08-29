import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { err } from "@arcforge/err"
import { fsx } from "../../../utils/fs"

/** Framework-owned variables the runtime sets. A project's .env cannot override these. */
const RESERVED = new Set([
    "AGENT_ID",
    "DEPLOYMENT_ID",
    "OWNER_USER_ID",
    "AXON_TIER",
    "AXON_WARMTH",
    "GCP_PROJECT_ID",
    "GCP_REGION",
    "AXON_SOURCE",
    "AGENT_ROOT",
    "AXON_API_BASE",
    "AXON_JWT_PUBLIC_KEY",
    "PORT",
    "K_SERVICE",
    "K_REVISION",
    "K_CONFIGURATION",
])

type EnvOpts = {
    root: string
}

/**
 * .env — the project's deployed environment.
 *
 * Production contract: `.env` is deployed; `.env.local` is dev-only and never
 * leaves the machine.
 */
export function Env(opts: EnvOpts) {
    const path = join(opts.root, ".env")

    return {
        path,

        /**
         * The validated environment a deploy uploads. Throws on a malformed
         * name or an attempt to override a framework-owned variable — both are
         * silent-breakage shapes if allowed through.
         */
        async production(): Promise<Record<string, string>> {
            const content = await fsx.readText(path)
            if (!content) return {}

            const values = parse(content)
            for (const key of Object.keys(values)) {
                if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
                    throw err("DEPLOY_ENV_INVALID", {
                        detail: `.env contains invalid environment variable name "${key}"`,
                        context: { key },
                    })
                }
                if (RESERVED.has(key)) {
                    throw err("DEPLOY_ENV_RESERVED", {
                        detail: `.env cannot override framework-owned variable "${key}"`,
                        context: { key },
                    })
                }
            }
            return values
        },

        /**
         * The variable names this agent's .env defines. Names only — a caller
         * listing keys must never be handed the secrets to render.
         */
        async keys(): Promise<string[]> {
            const content = await fsx.readText(path)
            return content ? Object.keys(parse(content)) : []
        },

        /**
         * Set one variable, creating .env if absent.
         *
         * ── Why a line edit, not a re-serialise ─────────────────────────────
         *
         * The file is the user's: comments, grouping and blank lines are how
         * they navigate it. Parsing to an object and writing it back would
         * silently discard all of that on the first `:key set`. So an existing
         * key is replaced IN PLACE, keeping its position, and a new one is
         * appended.
         *
         * ── Validated here, not at deploy ───────────────────────────────────
         *
         * `production()` already refuses malformed names and framework-owned
         * variables — but it refuses them at DEPLOY time, which is the worst
         * moment to discover a key you set days ago was never going to work.
         * The same two rules run here so the write fails at the keystroke that
         * caused it.
         */
        async set(key: string, value: string): Promise<void> {
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
                throw err("DEPLOY_ENV_INVALID", {
                    detail: `"${key}" is not a valid environment variable name`,
                    context: { key },
                })
            }
            if (RESERVED.has(key)) {
                throw err("DEPLOY_ENV_RESERVED", {
                    detail: `"${key}" is framework-owned and set by the runtime — an agent's .env cannot override it`,
                    context: { key },
                })
            }

            // Quoted whenever the value could not survive a round trip bare:
            // anything with whitespace (trimmed on read), a `#` (read as a
            // trailing comment), or a newline.
            const needsQuotes = /[\s#"']/.test(value) || value === ""
            const line = needsQuotes
                ? `${key}="${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`
                : `${key}=${value}`

            const content = await fsx.readText(path) ?? ""
            // Same shape the parser accepts, so an `export `-prefixed line is
            // found rather than duplicated below itself.
            const existing = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${key}[ \\t]*=.*$`, "m")

            if (existing.test(content)) {
                await writeFile(path, content.replace(existing, line))
                return
            }

            const separator = content === "" || content.endsWith("\n") ? "" : "\n"
            await writeFile(path, `${content}${separator}${line}\n`)
        },

        /**
         * Remove a variable from the agent's .env.
         *
         * The inverse of `set`, and it exists for the same reason `set` does:
         * disconnecting a channel has to leave the agent as it was BEFORE it was
         * connected, and a credential left behind means "disconnected" is not
         * true. Nothing else in the file is touched — comments, ordering and
         * unrelated keys survive, because a user's .env is theirs.
         *
         * A key that is not present is not an error: the caller wanted it gone,
         * and it is gone.
         */
        async unset(key: string): Promise<void> {
            const content = await fsx.readText(path)
            if (content === null) return

            // Same shape `set` matches, including an `export ` prefix, plus its
            // trailing newline so removing a line does not leave a blank one.
            const existing = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${key}[ \\t]*=.*$\\n?`, "m")
            if (!existing.test(content)) return

            await writeFile(path, content.replace(existing, ""))
        },

        parse: parse,
    }
}

export type EnvT = ReturnType<typeof Env>

/** Parse dotenv syntax: `export` prefixes, quoted values, trailing comments. */
function parse(content: string): Record<string, string> {
    const result: Record<string, string> = {}
    for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith("#")) continue
        const assignment = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed
        const equals = assignment.indexOf("=")
        if (equals < 1) continue

        const key = assignment.slice(0, equals).trim()
        let value = assignment.slice(equals + 1).trim()
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            const quote = value[0]
            value = value.slice(1, -1)
            if (quote === '"') value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t")
        } else {
            value = value.replace(/\s+#.*$/, "").trim()
        }
        result[key] = value
    }
    return result
}
