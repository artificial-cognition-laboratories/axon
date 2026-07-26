import { Hookable } from "hookable"
import type { AxonHooks } from "@arcforge/types"

/**
 * Thin wrapper over Hookable, typed against the `AxonHooks` contract in
 * @arcforge/types. One instance per runtime, constructed before Plugins() runs
 * so `axon.hooks.hook(...)` registrations land before any call point fires.
 *
 * Distinct from AxonBus: this is call-and-await-to-completion at a fixed
 * runtime call point, not many-to-many fire-and-forget notification.
 */
export function Hooks() {
    const hookable = new Hookable<AxonHooks>()

    return {
        hook: hookable.hook.bind(hookable),
        callHook: hookable.callHook.bind(hookable),
        removeHook: hookable.removeHook.bind(hookable),

        /**
         * Clears every registration. AxonServer() rebuilds from scratch on
         * every reload and reruns Plugins() in full — without this, a
         * plugin's hook.hook() calls would accumulate one extra registration
         * per reload, firing handlers multiple times for a single event.
         */
        reset: hookable.removeAllHooks.bind(hookable),
    }
}

export type AxonHooksT = ReturnType<typeof Hooks>
