/**
 * GitHub API client.
 *
 * Thin wrapper around @octokit/rest. Enforces token presence at call time,
 * propagates rate limit errors loudly, and exposes a single singleton instance
 * per agent process.
 *
 * Never swallows errors. If the API returns an error, it throws.
 */

import { Octokit } from "@octokit/rest"

let _octokit: Octokit | null = null

export function octokit(): Octokit {
    if (!_octokit) {
        const token = process.env.GITHUB_TOKEN
        if (!token) throw new Error(
            "GITHUB_TOKEN is not set — GitHub tools require a personal access token.\n" +
            "Create one at: https://github.com/settings/tokens"
        )
        _octokit = new Octokit({ auth: token })
    }
    return _octokit
}

/** Reset the singleton — used when the token changes or on shutdown. */
export function resetClient(): void {
    _octokit = null
}

/**
 * Wrap an Octokit call and rethrow rate limit errors with context.
 * All other errors propagate as-is.
 */
export async function call<T>(fn: () => Promise<T>): Promise<T> {
    try {
        return await fn()
    } catch (err: any) {
        if (err?.status === 403 && err?.response?.headers?.["x-ratelimit-remaining"] === "0") {
            const reset = err?.response?.headers?.["x-ratelimit-reset"]
            const resetAt = reset ? new Date(parseInt(reset, 10) * 1000).toISOString() : "unknown"
            throw new Error(`GitHub rate limit exceeded. Resets at: ${resetAt}`)
        }
        if (err?.status === 401) {
            throw new Error("GitHub token is invalid or expired. Check GITHUB_TOKEN.")
        }
        throw err
    }
}
