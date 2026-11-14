import { state } from "../src/state"

/**
 * Vox's derived state lives in module scope, so it outlives a reload of the
 * same process unless cleared. The clock itself is `mode.hz` in the config.
 */
export default definePlugin(({ hooks }) => {
    hooks.on("shutdown", () => {
        state.reset()
    })
})
