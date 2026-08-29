import { err } from "@arcforge/err"
/**
 * The agent process entrypoint — what the box execs.
 *
 * Symmetrical to the capsule's `process/main.ts`, and replacing it: read the
 * connection details from the env carrier the supervisor set, dial both
 * channels, boot the runtime, serve until told to stop.
 *
 * ── Why the env carrier ─────────────────────────────────────────────────────
 *
 * `Bun.spawn` exposes stdio only — no extra fds — so a pre-connected socket
 * cannot be inherited and the agent must find its sockets by path. The paths
 * arrive the same way the capsule's policy did: an env var set at spawn.
 */

export type AgentEntryEnv = {
    control: string
    data: string
}

/** The env var the supervisor sets. One carrier, parsed at one seam. */
export const AGENT_LINK_ENV = "AXON_AGENT_LINK"

/**
 * PATH to the blueprint, set by the supervisor alongside the link paths.
 *
 * A path rather than the blueprint itself: it carries every tool's bundled
 * source and runs to hundreds of kilobytes, which `systemd-run` inlines into
 * its own argv — past MAX_ARG_STRLEN, so every spawn failed with E2BIG. The
 * file lives in the socket directory, already mounted into the box.
 *
 * Here rather than in agent-main because agent-main is an ENTRYPOINT: it boots
 * an agent at module scope, so importing it for a string pulls that boot into
 * the importer's graph. `confined.ts` and this package's index both need the
 * name, and neither should be spawning anything by reading it.
 */
export const AGENT_BLUEPRINT_ENV = "AXON_AGENT_BLUEPRINT"

/**
 * Read the link paths this process was started with.
 *
 * Throws rather than defaulting. A missing carrier means the process was not
 * started by a supervisor, and an agent that guessed a socket path would either
 * fail obscurely later or — worse — connect to a different agent's supervisor.
 */
export function readLinkEnv(env: Record<string, string | undefined> = process.env): AgentEntryEnv {
    const raw = env[AGENT_LINK_ENV]
    if (!raw) {
        throw err("AGENT_LINK_MISSING", { detail: `${AGENT_LINK_ENV} is not set`, context: { env: AGENT_LINK_ENV } })
    }

    let parsed: unknown
    try {
        parsed = JSON.parse(raw)
    } catch (cause) {
        throw err("AGENT_LINK_MALFORMED", { detail: `${AGENT_LINK_ENV} is not valid JSON`, context: { env: AGENT_LINK_ENV }, cause })
    }

    const { control, data } = (parsed ?? {}) as Partial<AgentEntryEnv>
    if (typeof control !== "string" || typeof data !== "string") {
        throw err("AGENT_LINK_MALFORMED", { detail: `${AGENT_LINK_ENV} must carry string "control" and "data" paths`, context: { env: AGENT_LINK_ENV } })
    }
    return { control, data }
}

/** Encode the carrier. The supervisor's half of the same seam. */
export function writeLinkEnv(paths: AgentEntryEnv): string {
    return JSON.stringify(paths)
}
