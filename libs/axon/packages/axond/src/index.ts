/**
 * @arcforge/axond — the Axon daemon.
 *
 * Two roots: `Axond()` is the server, `AxonDaemon()` is the client every
 * consumer holds. See CLAUDE.md for why they mirror.
 */
export { Axond } from "./axond"
export { MachineAxond } from "./machine-axond"
export type { AxondOpts, AxondT } from "./axond"
export { AxonDaemon } from "./client"

/**
 * The domains, exported for a consumer that runs IN-PROCESS rather than over
 * the socket.
 *
 * The Fleet extension host is the case: it reads the running registry
 * directly, because the registry is files on disk and a daemon that happens
 * not to be listening must not make "what is running" unanswerable. Same
 * degraded path the CLI's own `machine` and `agents` verbs take.
 */
export { Agents } from "./agents"
export type { AgentsOpts, AgentsT, InstanceT } from "./agents"
export { Machine } from "./machine"
export type { MachineOpts, MachineT } from "./machine"
export type { AxonDaemonOpts, AxonDaemonT } from "./client"
/**
 * The daemon's command surface, exported so `axon daemon <verb>` is the same
 * code `axond` runs rather than a second implementation of it.
 */
export { Cli } from "./control/index"
export type { CliT } from "./control/index"
export { daemonPaths } from "./control/index"
export type { DaemonPaths, DaemonStarted, DaemonStatus } from "../types/index"
export type {
    Admission,
    Hold,
    MachineCapacity,
    MachineIdentity,
    MachineState,
    MachineUsage,
} from "./machine/index"
export type { AgentRecord, AgentsState, AxonInstance } from "./agents/index"
export { RepositoryJobs, RepositoryWork, Workspaces } from "./jobs/index"
export { Credential } from "./agents/index"
export type { CredentialT } from "./agents/index"
export type { Actor, Attachment, ChangeSet, ChangedFile, JobCheck, Job, JobEntry, JobEvent, JobRun, JobRunOutcome, JobRunStatus, JobRunTrigger, JobSchedule, JobVerdict, RepositoryJobsT, RepositoryWorkT, WorkspacesT } from "./jobs/index"
export type { ModelRecord, ModelRuntime, ModelsState } from "./models/index"
export { parseSpecifier, Artifacts, MODEL_PROTOCOL } from "./models/index"
/**
 * `LAB_IDS` is a VALUE, not only a type: every surface that has to cover each
 * lab — Fleet's sidebar, its console panes — iterates it, so adding a lab is
 * one entry in the daemon rather than an edit in each consumer.
 */
export { LAB_IDS } from "./labs/contract/index"
export type { BodyClient, BodyInfo, BodyState, BridgeState, Embodiment, LabAction, LabActionResult, LabIntervention, LabId, LabKind, LabState, LabT, Lease, LeaseInput, MinecraftAction, MinecraftPlace, MinecraftPlayer, Notice, Observer, RunningWorld, StudioOpened, StudioPlace, ScenarioEvent, ScenarioProgress, ScenarioRun, TerrariaAction, WorldInfo } from "./labs/index"
export type { ParsedSpecifier } from "./models/index"
