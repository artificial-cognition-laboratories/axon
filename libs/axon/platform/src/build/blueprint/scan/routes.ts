import { join } from "node:path"
import type { AxonRoute } from "@arcforge/types"
import { err } from "@arcforge/err"
import { fsx } from "../../../utils/fs"
import type { Scanned } from "../types"
import { installH3Globals } from "./h3-globals"

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const
type Method = (typeof METHODS)[number]

/**
 * Routes — server/api/ of ONE root. Filename convention:
 *   hello.get.ts → GET /api/hello · users/[id].post.ts → POST /api/users/[id]
 *   chat.ws.ts → WS /api/chat · hello.ts → ANY /api/hello
 * Module routes come from Modules() running this scanner per module root.
 *
 * This scanner IMPORTS each route file to resolve its handler — the
 * blueprint contract requires resolved handlers so the runtime mounts
 * as-is and never touches the filesystem. A route file that fails to
 * import or lacks a default-export handler is a warning, not a route.
 */
/**
 * Whether a file the author wrote that cannot be READ is fatal.
 *
 * True for an agent's own source: the agent is defined by what its author
 * wrote, so silently running a subset of it produces an agent nobody asked
 * for. Invalid state, and invalid states crash.
 *
 * False for a MODULE's, and that is the whole distinction: an agent that
 * installed a broken module is not an invalid agent — it is the agent it was
 * before the install. Crashing the runtime over one dependency leaves the user
 * unable to boot the terminal they need in order to remove it.
 *
 * Degrading was previously rejected because a warning "reached nobody at
 * runtime" — true then, since build:warning classified as debug and was hidden
 * at default verbosity. It is now info-level and renders as its own card, and
 * a module's failure additionally reaches the MODEL through scope.unavailable.
 *
 * Defaults to true: a caller that has not thought about it gets the strict
 * behaviour, and only the module scanner opts out.
 */
export async function Routes(root: string, opts: { required?: boolean } = {}): Promise<Scanned<AxonRoute>> {
    const entries: AxonRoute[] = []
    const warnings: Scanned<AxonRoute>["warnings"] = []

    installH3Globals()

    for (const { absPath, relPath } of await fsx.walk(join(root, "server", "api"))) {
        const parsed = parseRouteFile(relPath)
        if (!parsed) continue

        try {
            const mod = (await import(absPath)) as { default?: unknown }
            if (typeof mod.default !== "function") {
                warnings.push({ domain: "routes", error: `${absPath} has no default-export handler — skipped` })
                continue
            }
            entries.push({
                method: parsed.method,
                path: parsed.path,
                handler: mod.default as AxonRoute["handler"],
                file: absPath,
            })
        } catch (cause) {
            // A route that will not import means the agent serves an endpoint
            // set that is not the declared one — a caller gets a 404 for a file
            // sitting in server/api/. Fatal for the agent's own routes, and a
            // reported gap for a module's.
            const failure = err("ROUTE_LOAD_FAILED", {
                detail: `${absPath} — ${cause instanceof Error ? cause.message : String(cause)}`,
                context: { file: absPath },
                cause,
            })
            // Strict for an agent's own files, degraded for a module's.
            // Per FILE: one unreadable script skips that script, never the
            // rest of the directory beside it.
            if (opts.required !== false) throw failure
            warnings.push({ domain: "routes", error: failure.message, cause: failure })
            continue
        }
    }

    return { entries, warnings }
}

export function parseRouteFile(relPath: string): { method: Method | "ANY" | "WS"; path: string } | null {
    if (!relPath.endsWith(".ts") || relPath.endsWith(".test.ts")) return null

    const segments = relPath.replace(/\\/g, "/").slice(0, -3).split("/")
    const last = segments[segments.length - 1]!
    const dotParts = last.split(".")
    const suffix = dotParts[dotParts.length - 1]!.toUpperCase()

    let method: Method | "ANY" | "WS"
    let base: string

    if (suffix === "WS") {
        method = "WS"
        base = dotParts.slice(0, -1).join(".")
    } else if (METHODS.includes(suffix as Method)) {
        method = suffix as Method
        base = dotParts.slice(0, -1).join(".")
    } else {
        method = "ANY"
        base = last
    }

    return { method, path: "/api/" + [...segments.slice(0, -1), base].join("/") }
}
