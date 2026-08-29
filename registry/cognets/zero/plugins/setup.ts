// zero — lifecycle plumbing. Plugins wire the brain's fixed lifecycle
// points (boot, wake, tick, shutdown) to non-cognitive work: hydrating
// the resident model, checkpointing. Cognition never lives here — domain
// facts are stimuli that fold into the model via sync().
import { state, sync } from "../src/state"

export default definePlugin(({ hooks }) => {
    hooks.on("boot", async () => {
        sync()

        const checkpoint = await kernel.store.get("checkpoint")
        kernel.emit("cognet:log:info", {
            value: checkpoint
                ? `zero: hydrated ${state.entries.length} entries (checkpoint seq ${checkpoint.seq}, live seq ${state.seq})`
                : `zero: cold boot, hydrated ${state.entries.length} entries`,
        })
    })

    hooks.on("shutdown", async () => {
        await kernel.store.set("checkpoint", { seq: state.seq, savedAt: Date.now() })
    })
})
