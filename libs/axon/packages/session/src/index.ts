// @arcforge/session — the durable record.
//
// A stack-wide concept, like errors and types: the kernel commits to it, the
// runtime reads it, the TUI replays it, and a cognet rehydrates from it. It
// belongs to none of them, which is why it lives here rather than inside any.
//
// `home` travels with it because the on-disk layout IS part of what a session
// is — where the log lands and how a cognet's private state is namespaced.
export { AxonSession, type AxonSessionT, type SessionBus } from "./session"
export { home } from "./home"
