export { WorkspaceHandle, type WorkspaceHandle as WorkspaceHandleT } from "./handle"
export { Workspace, type WorkspaceT } from "./workspace"
export {
    materializeWorkspace,
    prepareWorkspaceTemplate,
    removeWorkspace,
    snapshotHash,
    snapshotWorkspace,
    workspaceChanges,
    type WorkspaceSnapshot,
} from "./files"
