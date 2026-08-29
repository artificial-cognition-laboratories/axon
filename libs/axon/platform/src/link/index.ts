/**
 * The supervisor ↔ agent transport, re-exported from `@arcforge/link`.
 *
 * The transport moved out when the daemon needed it: a daemon depending on the
 * whole platform to move bytes down a socket would invert the dependency the
 * daemon exists to establish. See that package for the layering.
 *
 * This shim stays because the platform genuinely still uses it — `agent-main`
 * and `services` run INSIDE the box and are built here, and every consumer
 * inside the platform imports through this path. Re-exporting is what let the
 * move land without touching any of them.
 */
export {
    Channel,
    type ChannelT,
    type ChannelHandlers,
    type ChannelSocket,
    FrameReader,
    encodeFrame,
    encodeMessage,
    decodeMessage,
    MAX_FRAME_BYTES,
    serve,
    connect,
    type LinkChannels,
    type SocketPaths,
    SupervisorLink,
    supervisorHandlers,
    agentServices,
    VERB,
    type SupervisorServices,
    agentHandlers,
    supervisorProxy,
    RemoteDriver,
    type AgentServices,
    AgentRuntime,
    type RuntimeForAgent,
    readLinkEnv,
    writeLinkEnv,
    AGENT_LINK_ENV,
    AGENT_BLUEPRINT_ENV,
    type AgentEntryEnv,
    prepare,
    socketRoot,
    socketPaths,
    type SpawnedAgent,
    spawnConfined,
    agentEntrypoint,
    agentEntrypoints,
    type ConfinedAgent,
} from "@arcforge/link"
import { agentEntrypoints } from "@arcforge/link"

/**
 * The supervisor-side services an agent's box is wired with, and the entry the
 * box execs. Platform-owned: both reach the cloud, the session log and the
 * blueprint scanners, which is precisely what does not belong in the wire.
 */
export { SupervisorSideServices } from "./services"

/**
 * Where the agent entrypoint lives — resolved against THIS package.
 *
 * `agent-main.ts` runs inside the box and reaches the cloud, the session log
 * and the blueprint scanners, so it stayed here when the wire moved to
 * `@arcforge/link`. The candidate list is therefore the platform's to state:
 * the transport composes the box, but only its owner knows where the program
 * it execs is written.
 */
export const AGENT_ENTRYPOINTS = agentEntrypoints(import.meta.dir)
