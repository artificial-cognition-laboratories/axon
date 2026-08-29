import { mkdirSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { serve, type LinkChannels, type SocketPaths } from "./socket"
import { SupervisorLink, supervisorHandlers, type SupervisorServices } from "./supervisor"
import { writeLinkEnv, AGENT_LINK_ENV } from "./entry"
import type { SupervisorToAgent } from "@arcforge/types"

/**
 * Spawning one confined agent and linking to it.
 *
 * The supervisor's half of the boundary: create the sockets, start listening
 * BEFORE the child exists, spawn it inside its box, and hand back a link.
 *
 * Ordering matters and is not incidental — listeners are armed first, because
 * a child that dials before anyone is listening gets ECONNREFUSED and dies at
 * startup. The capsule's tool loader has the same shape for the same reason
 * ("listeners armed — now ask").
 */

/**
 * Where one agent's sockets live.
 *
 * Under the same `~/.axon` dotdir as every other piece of per-user runtime
 * state, and `0o700` for the same reason the running records are: a unix
 * socket's permissions are the ONLY thing standing between this agent's
 * supervisor and any other local process. A world-writable directory here
 * would let any user on the box connect to a supervisor holding provider
 * credentials — which is the exact asset the whole boundary exists to protect.
 */
export function socketRoot(sessionId: string): string {
    return join(homedir(), ".axon", "cache", "link", sessionId)
}

export function socketPaths(sessionId: string): SocketPaths {
    const root = socketRoot(sessionId)
    return { control: join(root, "control.sock"), data: join(root, "data.sock") }
}

export type SpawnedAgent = {
    /** The four verbs, addressed to this agent. */
    link: SupervisorToAgent & { close(): void }
    /** Both channels, for a caller that needs the raw surface. */
    channels: LinkChannels
    /** Socket paths — the directory a confined agent needs bind-mounted. */
    paths: SocketPaths
    /** The directory to declare in the confinement spec's `control`. */
    root: string
    /** Env the child must be started with so it can find its supervisor. */
    env: Record<string, string>
    /** Stop listening and remove the socket directory. */
    dispose(): void
}

type PrepareOpts = {
    /** Identity of the conversation this agent serves. One session, one link. */
    sessionId: string
    /** What the supervisor holds and the agent may never: driver, log, decider. */
    services: SupervisorServices
    onError(error: Error): void
}

/**
 * Prepare the supervisor side and wait for the agent to connect.
 *
 * Returns only once BOTH channels have a peer, so a caller holding the result
 * can address the agent immediately rather than racing its own child. The
 * promise is deliberately not resolved early on one channel: a link with only
 * control connected can accept a stimulus it has no way to answer.
 *
 * The caller spawns the child between arming and awaiting — see `SpawnedAgent`
 * for the env and the mount path it must be given.
 */
export function prepare(opts: PrepareOpts): {
    paths: SocketPaths
    root: string
    env: Record<string, string>
    /** Resolves when the agent has dialled both channels. */
    connected: Promise<SpawnedAgent>
} {
    const root = socketRoot(opts.sessionId)
    const paths = socketPaths(opts.sessionId)

    // A previous process that died without unlinking leaves paths that
    // `listen` refuses (EADDRINUSE) even with nothing behind them.
    rmSync(root, { recursive: true, force: true })
    mkdirSync(root, { recursive: true, mode: 0o700 })

    const env = { [AGENT_LINK_ENV]: writeLinkEnv(paths) }

    const serving = serve({
        paths,
        ...supervisorHandlers(opts.services),
        onError: opts.onError,
    })

    const connected = serving.then((channels): SpawnedAgent => ({
        channels,
        paths,
        root,
        env,
        link: SupervisorLink({ channels, services: opts.services, onError: opts.onError }),
        dispose() {
            channels.close()
            rmSync(root, { recursive: true, force: true })
        },
    }))

    return { paths, root, env, connected }
}
