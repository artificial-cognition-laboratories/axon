/**
 * confine — OS-level confinement for the capsule subprocess. Linux only.
 *
 * Confinement() is the orchestrator external code uses; entrypoint() and probe()
 * are the ambient OS facts the build/spawn path needs. The leaves (Bwrap,
 * Cgroup) and the ConfinementSpec are internal — nothing outside constructs a
 * spec or an argv directly.
 */
export { Confinement, type ConfinementHandle, type ConfinementT } from "./Confinement"
export { probe, tierReady, entrypoint, CONFINE_USER, type ProbeStatus } from "./probe"
export { install, type InstallResult } from "./install"
