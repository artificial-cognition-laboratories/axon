// zero — lifecycle plumbing. Plugins wire the brain's fixed lifecycle
// points (boot, wake, tick, shutdown) to non-cognitive work: hydrating
// the resident model, checkpointing. Cognition never lives here — domain
// facts are stimuli that fold into the model via sync().
import { state, sync } from "../src/state"

export default definePlugin(({ hooks }) => {
    hooks.on("boot", async () => {
        // brain assembled, kernel bound, loop declared — not yet woken.
        // Hydrate the resident model from the episodic log: nothing is
        // passed in, the cognet reads what it wants (store.session is the
        // whole rehydration story for a log-derived mind).
        sync()

        // checkpoint is a cursor, never memory — a mismatch (or absence)
        // costs nothing because sync() already rebuilt from the log.
        const checkpoint = await kernel.store.get("checkpoint")
        kernel.emit("cognet:log:info", {
            value: checkpoint
                ? `zero: hydrated ${state.entries.length} entries (checkpoint seq ${checkpoint.seq}, live seq ${state.seq})`
                : `zero: cold boot, hydrated ${state.entries.length} entries`,
        })
    })

    hooks.on("shutdown", async () => {
        // durable episodic writes already happened through the kernel at
        // the moment they mattered; the only thing worth persisting from
        // RAM is the cursor.
        await kernel.store.set("checkpoint", { seq: state.seq, savedAt: Date.now() })
    })
})
