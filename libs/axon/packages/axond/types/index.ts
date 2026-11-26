/**
 * Public types for @arcforge/axond.
 *
 * Split from the runtime so a consumer can type against the daemon without
 * importing it — the Fleet extension host and the TUI both hold the client
 * handle, and neither should pull the server's composition root into its
 * bundle to name a status.
 */
export type { DaemonPaths, DaemonStarted, DaemonStatus } from "./daemon"
export { LAB_IDS } from "../src/labs/contract"
export type { BodyClient, BodyInfo, BodyState, BridgeState, Embodiment, LabId, LabKind, LeaseInput, LabState, LabT, Lease, Notice, Observer, RunningWorld, StudioOpened, StudioPlace, ScenarioEvent, ScenarioProgress, ScenarioRun, WorldInfo } from "../src/labs/contract"
