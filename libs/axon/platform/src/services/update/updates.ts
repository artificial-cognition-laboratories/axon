import { existsSync, realpathSync } from "node:fs"
import { mkdir, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { gt, valid } from "semver"
import type { AxonCloudClient } from "@arcforge/cloud"
import type { StoreT } from "../store"
import { UPDATE_REQUEST_ENV, type UpdateRequest } from "./contract"
import { err } from "@arcforge/err"

export type UpdateCheck =
    | { status: "current"; current: string; latest: string }
    | { status: "available"; current: string; latest: string }

type UpdatesOpts = {
    cloud: AxonCloudClient
    store: StoreT
    /**
     * The running app's version. Supplied by the caller rather than read
     * from a package.json here — this package is a library, and the
     * version that matters is the shipped app's, not its own.
     */
    currentVersion: string
    helperPath?: string
    bunPath?: string
    axonPath?: string
    requestPath?: string
}

/** Headless Axon self-update orchestration shared by the CLI and TUI. */
export function Updates(opts: UpdatesOpts) {
    const currentVersion = opts.currentVersion
    // Global package managers expose `axon` through a symlink/shim. Resolve the
    // real entry file before looking beside it for the packaged helper.
    const invokedEntryPath = process.argv[1] ?? import.meta.path
    const helperPath = opts.helperPath ?? packagedHelperPath(invokedEntryPath)
    const bunPath = opts.bunPath ?? process.execPath
    // Resolved lazily: construction is wiring, and Bun.which() both shells
    // out and is undefined under Node — which is what the Fleet extension
    // host runs, so eagerly calling it here threw before the platform
    // finished constructing and took the whole extension down with it.
    const axonPath = opts.axonPath ?? (typeof Bun === "undefined" ? "axon" : Bun.which("axon") ?? "axon")
    const requestPath = opts.requestPath ?? process.env[UPDATE_REQUEST_ENV]

    function supported(): boolean {
        return existsSync(helperPath) && Boolean(requestPath)
    }

    async function check(signal?: AbortSignal, options: { fresh?: boolean } = {}): Promise<UpdateCheck> {
        if (!valid(currentVersion)) {
            throw err("UPDATE_CURRENT_VERSION_INVALID", { context: { version: currentVersion } })
        }
        const release = await opts.cloud.cloud.releases.axon(signal, options)
        if (release.package !== "@arcforge/axon" || release.channel !== "latest" || !valid(release.version)) {
            throw err("UPDATE_RELEASE_INVALID", {
                context: { package: release.package, channel: release.channel, version: release.version },
            })
        }
        return {
            status: gt(release.version, currentVersion) ? "available" : "current",
            current: currentVersion,
            latest: release.version,
        }
    }

    async function handoff(signal?: AbortSignal): Promise<UpdateCheck> {
        // The status indicator is deliberately cacheable. The version handed to
        // the package manager is not: refresh it at the point of commitment so
        // a release published moments ago cannot leave us installing a stale tag.
        const result = await check(signal, { fresh: true })
        if (result.status === "current") return result
        if (!supported()) throw err("UPDATE_UNAVAILABLE_IN_DEVELOPMENT")

        opts.store.update.state.set({
            status: "pending",
            from: result.current,
            to: result.latest,
            updatedAt: new Date().toISOString(),
        })

        try {
            const request: UpdateRequest = {
                from: result.current,
                to: result.latest,
                bun: bunPath,
                axon: axonPath,
                state: opts.store.update.statePath,
            }
            if (!requestPath) throw err("UPDATE_SUPERVISOR_UNAVAILABLE")
            await mkdir(dirname(requestPath), { recursive: true })
            const temporary = `${requestPath}.${process.pid}.tmp`
            await writeFile(temporary, JSON.stringify(request, null, 2) + "\n", "utf-8")
            await rename(temporary, requestPath)
        } catch (error) {
            opts.store.update.state.set({
                status: "failed",
                from: result.current,
                to: result.latest,
                updatedAt: new Date().toISOString(),
                error: error instanceof Error ? error.message : String(error),
            })
            throw error
        }
        return result
    }

    return {
        currentVersion: currentVersion,
        supported: supported,
        check: check,
        handoff: handoff,
    }
}

/**
 * Where the packaged update helper sits — beside the entry file that invoked us.
 *
 * Exported for its own test: the resolution only runs when `helperPath` is NOT
 * injected, and that path reads process.argv[1], which a test cannot set. The
 * symlink case it handles is the difference between updates working and
 * silently reporting unsupported, so it is worth covering directly.
 *
 * Global package managers expose `axon` through a symlink or shim, so the
 * invoked path is resolved to its real location first: looking beside the
 * symlink finds nothing, and updates would silently report unsupported.
 */
export function packagedHelperPath(entryPath: string): string {
    let real = entryPath
    try {
        real = realpathSync(entryPath)
    } catch {
        // A path we cannot stat is one we cannot resolve past — use it as given
        // and let existsSync() below decide whether the helper is really there.
    }
    return join(dirname(real), "update-helper.js")
}

export type UpdatesT = ReturnType<typeof Updates>
