/**
 * @arcforge/link — the supervisor ↔ agent transport.
 *
 * ── Three layers, each testable without the one above it ────────────────────
 *
 *   frame    length-prefixed framing over a stream socket (pure)
 *   channel  request/response correlation, streams, aborts (pure, loopback-testable)
 *   socket   unix sockets, the write queue, backpressure (the only I/O)
 *
 * Above those sit the VERBS — `supervisor`, `agent`, `runtime` — which carry
 * the `SupervisorToAgent` / `AgentToSupervisor` contract from
 * `@arcforge/types`, and `confined`, which composes the OS box an agent is
 * exec'd into.
 *
 * ── Why this is its own package ─────────────────────────────────────────────
 *
 * It was `@arcforge/platform/src/link` while the platform was the only thing
 * that supervised agents. The daemon supervises them now, and a daemon that
 * had to depend on the whole platform — projects, cloud, extensions, the
 * registry — to move bytes down a socket would invert the dependency the
 * daemon exists to establish.
 *
 * What made the split cheap is that the wire never needed any of that: every
 * file here depends on `@arcforge/err` and `@arcforge/types` and nothing else.
 *
 * ── What is deliberately NOT here ───────────────────────────────────────────
 *
 * `agent-main.ts` and `services.ts` — the process that runs INSIDE the box —
 * stay in the platform. They carry every heavy dependency (`@arcforge/core`,
 * `@arcforge/session`, `@arcforge/cloud`, the blueprint scanners), and they are
 * an ENTRYPOINT rather than a module: the supervisor spawns them by resolving
 * a path, and nothing imports them across the boundary. Keeping them out is
 * what holds this package to two dependencies.
 */
export { Channel, type ChannelT, type ChannelHandlers, type ChannelSocket } from "./channel"
export { FrameReader, encodeFrame, encodeMessage, decodeMessage, MAX_FRAME_BYTES } from "./frame"
export { serve, connect, type LinkChannels, type SocketPaths } from "./socket"
export { SupervisorLink, supervisorHandlers, agentServices, VERB, type SupervisorServices } from "./supervisor"
export { agentHandlers, supervisorProxy, RemoteDriver, type AgentServices } from "./agent"
export { AgentRuntime, type RuntimeForAgent } from "./runtime"
export { readLinkEnv, writeLinkEnv, AGENT_LINK_ENV, AGENT_BLUEPRINT_ENV, type AgentEntryEnv } from "./entry"
export { prepare, socketRoot, socketPaths, type SpawnedAgent } from "./spawn"
export { spawnConfined, agentEntrypoint, agentEntrypoints, type ConfinedAgent } from "./confined"
