// update — Axon's self-update, split across three processes.
// Updates() is the in-app service; contract.ts is the handshake all three share.

export { Updates, packagedHelperPath, type UpdatesT, type UpdateCheck } from "./updates"
export { Installer, type InstallerT, type InstallerIo } from "./installer"
export {
    UPDATE_REQUEST_ENV,
    UPDATE_REQUEST_EXIT_CODE,
    toArgv,
    fromArgv,
    type UpdateRequest,
} from "./contract"
