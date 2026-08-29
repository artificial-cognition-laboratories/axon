import { err } from "@arcforge/err"

/**
 * The three-process update handshake.
 *
 * Updating cannot happen inside the running app — a package manager cannot
 * replace the binary of a live program — so it is spread across three
 * processes that only ever agree on what is in this file:
 *
 *   bin/supervisor.ts     the real CLI entrypoint; spawns the app, and on
 *                         EXIT_CODE spawns the helper
 *   the app               Updates().handoff() writes a request to REQUEST_ENV's
 *                         path and exits with EXIT_CODE
 *   bin/update-helper.ts  reads the request off argv, installs, verifies,
 *                         rolls back on failure
 *
 * Nothing else is shared between them: no imports across the boundary, no
 * assumptions about each other's internals. Change anything here and all three
 * must be rebuilt together, which is exactly why it is one small file.
 */

/** The app exits with this to tell the supervisor an update was requested. */
export const UPDATE_REQUEST_EXIT_CODE = 75

/** Env var carrying the path the app writes its request to. Absent = updates unsupported. */
export const UPDATE_REQUEST_ENV = "AXON_UPDATE_REQUEST"

export type UpdateRequest = {
    from: string
    to: string
    /** Absolute path to the bun binary that will perform the install. */
    bun: string
    /** Absolute path to the axon binary, used to verify the installed version. */
    axon: string
    /** Absolute path to the state file both the helper and the next launch read. */
    state: string
}

const FIELDS = ["from", "to", "bun", "axon", "state"] as const

/** A request → the argv the supervisor passes the helper. */
export function toArgv(request: UpdateRequest): string[] {
    return FIELDS.flatMap(field => [`--${field}`, request[field]])
}

/**
 * The helper's argv → a request.
 *
 * Validates semver on both versions before returning: these values reach a
 * shell command, and the helper is spawned against a request file living in a
 * world-writable temp directory. A version that is not a version is refused
 * here rather than interpolated into `bun add`.
 */
export function fromArgv(argv: string[]): UpdateRequest {
    const values = new Map<string, string>()
    for (let i = 0; i < argv.length; i += 2) {
        const key = argv[i]
        const value = argv[i + 1]
        if (!key?.startsWith("--") || value === undefined) throw err("UPDATE_HELPER_ARGS_INVALID")
        values.set(key.slice(2), value)
    }

    const missing = FIELDS.filter(field => !values.get(field))
    if (missing.length > 0) {
        throw err("UPDATE_HELPER_ARGS_INVALID", { detail: `missing ${missing.map(field => `--${field}`).join(", ")}` })
    }

    const request = Object.fromEntries(FIELDS.map(field => [field, values.get(field)!])) as UpdateRequest
    if (!isSemver(request.from) || !isSemver(request.to)) {
        throw err("UPDATE_HELPER_VERSION_INVALID", { context: { from: request.from, to: request.to } })
    }
    return request
}

function isSemver(value: string): boolean {
    return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)
}
