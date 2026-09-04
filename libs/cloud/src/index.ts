export { AxonCloud } from "./AxonCloud"
export type { AxonCloudClient } from "./AxonCloud"
export { Agents, RemoteAgent } from "./cloud/agents"
export type { AgentsHandle, AttachResult, RemoteAgentHandle } from "./cloud/agents"
export { HttpError, PRODUCTION_API_BASE, resolveDefaultBaseUrl } from "./platform/http"
export type { HttpClient, HttpErrorCode } from "./platform/http"
export { Reporting, scrubContext, toReportFrames } from "./platform/reporting"
export type { ReportingHandle } from "./platform/reporting"
export { reportRuntimeErrors, isReportable } from "./platform/runtime-reporting"
export type { ReportableError } from "./platform/runtime-reporting"
export type { AxonRelease, ReleasesHandle } from "./cloud/releases"
export type { EngineHandle, EngineResolve, ResolvedEngineModel } from "./cloud/engine"
export type { AuthSession, AuthUser, DeviceAuthorization } from "./user/auth/types"
export { API_KEY_SCOPES, API_KEY_SCOPE_DESCRIPTIONS } from "./user/keys"
export type { ApiKey, ApiKeyScope } from "./user/keys"
export type { ActivityItem } from "./user/activity"
export type { StarredItem } from "./user/starred"
export type { Pin } from "./user/pins"
export type { DirectoryEntry } from "./registry/directory"
export type { MyProfile, ProfileLink, ProfileUpdate } from "./user/profile"
export type { OverviewStats, UptimePoint, ErrorPoint, ProfilePoint } from "./user/overview"
export type { StaffSeries, StaffStats, StaffLists, StaffUser, StaffTransaction, StaffFailure, LastSeenSource } from "./staff/stats"
export type { ReportGroup, ReportHealth, ReportsResponse } from "./staff/reports"
export type { PublicProfile, PublicCatalogItem } from "./registry/profile"
export type { Dependent, Dependency, DependencyClass } from "./registry/artifacts/types"
export type { Scope, ScopeKind, ScopeProfile, ScopeArtifact, ScopeLink, ScopeStats } from "./registry/scopes"
export type { CodexCredential, CodexUsage, CodexUsageWindow, ConnectionStatus, ConnectionToken, VaultSecretMeta } from "./user/vault"
export type { AxonModelInfo, ModelCatalog, ModelInfo, RegistryModel, RegistryRoute, SourceState } from "./registry/models"
export { InsufficientFundsError, DeploymentFailedError } from "./registry/agents/types"
export type { AgentRecord, AgentStats, AgentVersion, DeployOptions, DeploymentRecord, DeploymentStatus, DeployStep, DeployTier, DeployWarmth } from "./registry/agents/types"
export type { ModuleRecord, ModuleStats, ModuleVersion, ModuleUpdate, ResolvedModule } from "./registry/modules/types"
export { ARTIFACT_KINDS } from "./registry/artifacts"
export { SORT_ORDERS, parseKinds, parseLimit, parseSort, refine } from "./registry/artifacts"
export type { SearchInput, SortOrder } from "./registry/artifacts"
export type { ArtifactAsset, ArtifactKind, ArtifactRecord, ArtifactStats, ArtifactUpdate, ArtifactVersion, ResolvedArtifact } from "./registry/artifacts"
export type { ArtifactHandle, ArtifactsHandle } from "./registry/artifacts"
export type {
    AutoTopupInput,
    AutoTopupPolicy,
    BillingAccount,
    BillingBalance,
    Card,
    Commitment,
    CommitmentQuote,
    DailyBalance,
    LedgerEntry,
    SpendByReference,
    TopupResult,
    UsageSummary,
} from "./user/billing/types"
export type { AgentHandle } from "./registry/agents/agents"
export type { DeploymentHandle } from "./registry/agents/deployment"
export type { ActivityRange, RegistryHandle } from "./registry/registry"

/**
 * Registry source trees — tarball to navigable file tree.
 *
 * Isomorphic and client-free: it takes a `download` thunk rather than holding
 * a handle, so a Nuxt page, an extension host and a CLI all use one parser.
 */
export {
    sourceTree,
    parseTar,
    buildTree,
    withAssets,
    findFile,
    findFileByExtension,
    fileIcon,
    folderIcon,
    fileLang,
} from "./registry/source"
export type { FileNode, FileTreeData } from "./registry/source"
