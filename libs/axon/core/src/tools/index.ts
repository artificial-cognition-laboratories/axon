/**
 * tools — the agent's executable scope, loaded in its own process.
 *
 * Replaces the capsule's split tool machinery (a guest-side loader plus a
 * host-side wire handshake) with one in-process operation. The mediation
 * wrapper survives intact: once the whole agent runs inside an OS box, bwrap
 * is the security wall and this becomes the audit and escalation layer.
 */
export { Tools, type ToolsT } from "./tools"
export { loadTool, type LoadedTool } from "./load"
export { mediate, type MediateOpts } from "./mediate"
