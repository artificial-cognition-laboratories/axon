export { Platform, type PlatformT } from "./platform"
export type { ProjectKind, ProjectT } from "./build/project"
// The `@` palette renders these rows, so the shape is part of the platform's
// public surface rather than an internal of the walk that produces it.
export type { FileEntry, FilesT } from "./services/files"
// The process tree every surface renders — folded from the session log, so a
// local runtime and an attached deployment read identically.
export { procTree, appendOutput, type ProcNode } from "./procs"
// The live instance forest — agents, their subagents, and each one's procs as
// one tree. The TUI's `/` palette and the Fleet extension's Instances view
// both render it; the ordering rules are subtle enough that a second
// implementation would drift rather than differ.
export { forest, childrenOf, flatten, type ForestAgent, type ForestNode, type Indented } from "./procs"
// The supervisor ↔ agent transport. Moves bytes; the verbs it carries are
// SupervisorToAgent / AgentToSupervisor in @arcforge/types.
export { serve, connect, Channel, type LinkChannels, type SocketPaths, type ChannelT } from "./link"
