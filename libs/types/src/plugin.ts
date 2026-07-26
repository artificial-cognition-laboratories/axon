import type { AxonHandle } from "./handle"

/**
 * Boot-time plugin. Runs once, after middleware and before routes are
 * mounted. A throwing plugin aborts boot — plugin failure is always fatal.
 *
 * `fn` receives THIS runtime's `axon` handle as an argument — not the injected
 * global. A process may host several Axon() instances at once (the TUI runs
 * one per conversation), and a bare `globalThis.axon` is whichever booted
 * last. Passing the handle binds each plugin to its own runtime.
 */
export type AxonPlugin = {
    name: string
    fn: (axon: AxonHandle) => void | Promise<void>
}
