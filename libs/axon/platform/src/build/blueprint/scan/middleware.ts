import { basename, join } from "node:path"
import { defineMiddleware } from "@arcforge/types"
import type { AxonMiddleware } from "@arcforge/types"
import { err } from "@arcforge/err"
import { fsx } from "../../../utils/fs"
import type { Scanned } from "../types"
import { installH3Globals } from "./h3-globals"

/**
 * Middleware files use the ambient `defineMiddleware` global plus the same h3
 * helpers route files get — agent authors never import either. Install the
 * real implementations before importing middleware files (idempotent).
 */
function installMiddlewareGlobals(): void {
    const g = globalThis as Record<string, unknown>
    g.defineMiddleware ??= defineMiddleware
    installH3Globals()
}

/**
 * Middleware — server/middleware/ of ONE root. Each file default-exports a
 * defineMiddleware() result and runs on EVERY request, ahead of plugins,
 * the reserved /_axon/* surface, and user routes alike.
 *
 * ORDER IS THE FILENAME. Nitro's contract, kept exactly: middleware is sorted
 * lexicographically by path, so `01.auth.ts` runs before `02.log.ts` and an
 * author controls sequence by naming rather than by a config list. fsx.walk
 * gives no ordering guarantee of its own, so the sort here is what makes the
 * contract real — without it, two agents with identical files could gate
 * requests in different orders on different machines.
 *
 * Module middleware comes from Modules() running this scanner per module
 * root, exactly as it does for routes and plugins.
 *
 * This scanner IMPORTS each file to resolve its handler — the blueprint
 * contract requires resolved values so the runtime mounts as-is and never
 * touches the filesystem. A file that fails to import or lacks a default
 * export is a warning, not middleware.
 */
export async function Middleware(root: string, opts: { required?: boolean } = {}): Promise<Scanned<AxonMiddleware>> {
    const entries: AxonMiddleware[] = []
    const warnings: Scanned<AxonMiddleware>["warnings"] = []

    installMiddlewareGlobals()

    const files = await fsx.walk(join(root, "server", "middleware"))
    // Lexicographic by relative path — the ordering contract above.
    const ordered = [...files].sort((a, b) => a.relPath.localeCompare(b.relPath))

    for (const { absPath, relPath } of ordered) {
        if (!relPath.endsWith(".ts") || relPath.endsWith(".test.ts")) continue

        try {
            const mod = (await import(absPath)) as { default?: unknown }
            const entry = mod.default as AxonMiddleware | undefined

            // A bare defineEventHandler default-export is accepted too: it is
            // the shape an author reaches for out of h3 habit, and refusing it
            // would fail with "no default-export defineMiddleware()" for a file
            // that is otherwise perfectly valid.
            const handler = entry && typeof entry.handler === "function"
                ? entry.handler
                : typeof mod.default === "function"
                    ? (mod.default as AxonMiddleware["handler"])
                    : undefined

            if (!handler) {
                warnings.push({ domain: "middleware", error: `${absPath} has no default-export defineMiddleware() — skipped` })
                continue
            }

            // The filename names what the middleware does ("auth"), which reads
            // better in boot errors than defineMiddleware's generic fallback for
            // an anonymous arrow. Same rule as plugins.
            const named = entry?.name && entry.name !== "middleware" ? entry.name : basename(relPath, ".ts")
            entries.push({ name: named, handler })
        } catch (error) {
            const failure = err("MIDDLEWARE_LOAD_FAILED", {
                detail: `${absPath} — ${error instanceof Error ? error.message : String(error)}`,
                context: { file: absPath },
                cause: error,
            })

            // Strict for an agent's own middleware, degraded for a module's —
            // but "degraded" here does NOT mean skipped.
            //
            // Middleware commonly carries auth and validation. A skipped one is
            // a request path running without the checks its author wrote: not a
            // missing capability, but a security hole wearing the costume of a
            // working server. So the entry is KEPT, carrying its reason, and
            // the runtime replaces it with a handler that refuses every request
            // — the route stays addressable and answers 503, exactly as a
            // reverse proxy does for a backend it cannot reach.
            //
            // That is also why there is no "allow degraded in dev" switch.
            // There is no environment in which serving unguarded is correct:
            // dev is where the client that assumes auth works gets built, and
            // where a real token gets pasted into a request nothing checks.
            if (opts.required !== false) throw failure

            // basename, not `named`: that is bound inside the try and the
            // module never loaded, so the filename is the only name there is.
            entries.push({ name: basename(relPath, ".ts"), failed: failure.message })
            warnings.push({ domain: "middleware", error: failure.message, cause: failure })
            continue
        }
    }

    return { entries, warnings }
}
