/** One callable or value declaration installed in an execution scope. */
export type AxonScopeMember = {
    /** Stable member name, used for collision checks and diagnostics. */
    name: string
    /** Standalone TypeScript declaration (`function x(...)`, `const x: ...`). */
    declaration: string
    /** Model-facing documentation carried with the declaration. */
    jsdoc?: string
}

/**
 * A related group of globals in the capsule's executable TypeScript scope.
 *
 * Namespaced modules render as `declare namespace <name> { ... }`. Flat
 * modules install each member directly on globalThis. `ambientTypes` are
 * emitted before members so every referenced type is resolvable.
 */
export type AxonScopeModule = {
    name: string
    description?: string
    members: readonly AxonScopeMember[]
    flat?: boolean
    ambientTypes?: readonly string[]
}

/** The complete TypeScript scope implemented by one live capsule. */
export type AxonScope = {
    modules: readonly AxonScopeModule[]
}
