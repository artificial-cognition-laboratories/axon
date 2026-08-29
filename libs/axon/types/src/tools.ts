import type { AxonScopeMember } from "./scope"

/** Function exported by a tool namespace and discovered for agent use. */
export type ToolFnEntry = AxonScopeMember

/** Tool namespace discovered from an agent, module, or installed package. */
export type AxonTool = {
    /** Package name or local `src/tools/` namespace name. */
    name: string
    /** Human-readable namespace summary, usually extracted from package metadata or JSDoc. */
    description?: string
    /** Callable functions available under this namespace. */
    fns: ToolFnEntry[]
    /**
     * "src"       — from agent's src/tools/<name>.ts
     * "module"    — from modules/<module-name>/src/tools/
     * "workspace" — from the shared workspace tools/ directory
     *
     * There is no "package" origin: an npm dependency is importable by the
     * agent's own source, but the capsule is a separate process and a
     * dependency grants nothing there. Re-export from src/tools/ to make
     * one callable.
     */
    origin: "src" | "module" | "workspace"
    /** Absolute path to the module root — present when origin is "module" or a workspace module. */
    modulePath?: string
    /**
     * Absolute entry file for this tool. Capsule imports this module in place
     * so its relative imports and normal package resolution remain intact.
     */
    entryPath?: string
    /**
     * Inline source is a compatibility escape hatch for programmatically
     * constructed blueprints. Project scanning uses entryPath instead: a tool
     * file is a module, not a self-contained source string.
     */
    source?: string
    /**
     * Interface/type-alias declarations this tool's functions reference
     * (e.g. a return type defined in a sibling file), deduped by name, in
     * the order first encountered. Emitted once per tool by both
     * consumers -- renderScope() (the live model context) and the IDE's
     * tool-globals.d.ts — rather than duplicated inline into every
     * fn.declaration that uses them. Empty/absent when a tool's functions
     * only use built-in/primitive types.
     */
    ambientTypes?: string[]
}
