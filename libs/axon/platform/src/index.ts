export { Platform, type PlatformT } from "./platform"
export type { ProjectKind, ProjectT } from "./build/project"
// The `@` palette renders these rows, so the shape is part of the platform's
// public surface rather than an internal of the walk that produces it.
export type { FileEntry, FilesT } from "./services/files"
// The process tree every surface renders — folded from the session log, so a
// local runtime and an attached deployment read identically.
export { procTree, appendOutput, type ProcNode } from "./procs"
// The supervisor ↔ agent transport. Moves bytes; the verbs it carries are
// SupervisorToAgent / AgentToSupervisor in @arcforge/types.
export { serve, connect, Channel, type LinkChannels, type SocketPaths, type ChannelT } from "./link"
