import { readFile, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { text } from "./text"

type BunfigOpts = {
    root: string
}

/**
 * bunfig.toml — the agent's scope → registry map.
 *
 * Bun resolves a package by looking up its SCOPE, so every namespace an agent
 * installs from must appear here or Bun asks npmjs.com and 404s. `@axon` is
 * scaffolded in, but modules are published under user and org namespaces too
 * (`@cody/thing`), and those cannot be known ahead of time — so installing a
 * scope for the first time registers it.
 *
 * Only scopes Axon actually serves are added. Anything else keeps resolving
 * against public npm, which is what makes an agent able to depend on ordinary
 * packages alongside Axon modules.
 */
export function Bunfig(opts: BunfigOpts) {
    const path = join(opts.root, "bunfig.toml")

    /**
     * Point `scope` at this registry, adding it or CORRECTING it.
     *
     * The correction is the part that matters. This used to return early the
     * moment the scope existed, without ever checking the URL — so a project
     * prepared against production kept fetching from production after
     * switching to local staging, and vice versa. The two registries then
     * mixed in the worst possible way: ranges resolved from one, tarballs
     * fetched from the other, and a lockfile pinning URLs from whichever
     * happened to be configured first.
     *
     * The URL is the whole content of the entry, so "already present" and
     * "already correct" are different questions and only the second licenses
     * doing nothing.
     */
    async function ensure(scope: string, registryUrl: string): Promise<boolean> {
        const source = existsSync(path) ? await readFile(path, "utf-8") : ""
        if (urlOf(source, scope) === registryUrl) return false

        // Drop any existing entry before writing, so a corrected scope
        // replaces its old line rather than appearing twice — bun reads the
        // first match, which would silently keep the stale registry.
        await writeFile(path, withScope(withoutScope(source, scope), scope, registryUrl))
        return true
    }

    return {
        path,

        /** Ensure `scope` maps to this registry, adding it if absent. Returns whether the file changed. */
        ensure,

        /** Ensure every scope in `names` (full package names) is mapped. */
        async ensureAll(names: string[], registryUrl: string): Promise<boolean> {
            let changed = false
            const scopes = new Set(names.map(scopeOf).filter((scope): scope is string => scope !== null))
            for (const scope of scopes) {
                if (await ensure(scope, registryUrl)) changed = true
            }
            return changed
        },

        scopeOf,

        /**
         * Every scope this project maps, and the registry each points at.
         *
         * Read by `verify` to catch a bunfig left pointing at the registry a
         * previous run used — the failure where ranges resolve against one
         * registry and tarballs are fetched from another.
         */
        async scopes(): Promise<Record<string, string>> {
            if (!existsSync(path)) return {}
            const source = await readFile(path, "utf-8")
            const found: Record<string, string> = {}
            const entry = /^\s*['"]?([A-Za-z0-9_-]+)['"]?\s*=\s*\{[^}]*url\s*=\s*["']([^"']+)["']/gm
            for (const match of source.matchAll(entry)) found[match[1]!] = match[2]!
            return found
        },
    }
}

export type BunfigT = ReturnType<typeof Bunfig>

/** "@axon/obsidian" → "axon". Unscoped names have no scope to map. */
export function scopeOf(packageName: string): string | null {
    const match = /^@([^/]+)\//.exec(packageName)
    return match ? match[1]! : null
}

function has(source: string, scope: string): boolean {
    return new RegExp(`^\\s*['"]?${text.escape(scope)}['"]?\\s*=`, "m").test(source)
}

/**
 * The registry URL currently mapped to `scope`, or null when unmapped.
 *
 * Reading the URL rather than merely detecting the scope is what lets `ensure`
 * tell "already present" from "already correct" — the distinction a registry
 * switch depends on.
 */
function urlOf(source: string, scope: string): string | null {
    const match = new RegExp(
        `^\\s*['"]?${text.escape(scope)}['"]?\\s*=\\s*\\{[^}]*url\\s*=\\s*["']([^"']+)["']`,
        "m",
    ).exec(source)
    return match?.[1] ?? null
}

/** Remove a scope's line entirely, so a rewrite cannot leave a duplicate behind. */
function withoutScope(source: string, scope: string): string {
    return source
        .split("\n")
        .filter(line => !new RegExp(`^\\s*['"]?${text.escape(scope)}['"]?\\s*=`).test(line))
        .join("\n")
}

/**
 * Insert the scope into `[install.scopes]`, creating that table if the file has
 * none. The entry goes directly under the header so it cannot land inside a
 * later table and silently change meaning.
 */
function withScope(source: string, scope: string, registryUrl: string): string {
    const entry = `${scope} = { url = "${registryUrl}" }`

    const header = /^\[install\.scopes\][ \t]*\r?\n/m.exec(source)
    if (!header) {
        const separator = source === "" || source.endsWith("\n") ? "" : "\n"
        return `${source}${separator}[install.scopes]\n${entry}\n`
    }

    const at = header.index + header[0].length
    return source.slice(0, at) + entry + "\n" + source.slice(at)
}
