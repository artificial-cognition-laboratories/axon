
/** Prompt template discovered from an agent or module. */
export type AxonPrompt = {
    /** Prompt name used with `axon.prompt(name)`. */
    name: string
    /** Static markdown prompt or dynamic Vuedown prompt. */
    kind: "static" | "dynamic"
    /** Human-readable prompt summary. */
    description?: string
    /**
     * Absolute path to the prompt file. Set during discovery so the runtime
     * can load the file without re-deriving the path from the name convention.
     * Present for agent-owned and module prompts; absent for inline prompts.
     */
    filePath?: string
    /**
     * Components this prompt may compose, as PascalCase name → absolute path.
     *
     * Resolved at scan time rather than at render: the renderer would
     * otherwise have to re-derive the owning root from filePath and hit the
     * filesystem on every call, and a prompt package's components sit at a
     * different depth from an agent's. Scanning already knows both.
     *
     * Components are not prompts — they are never invokable, and exist only
     * to be inlined into one at render time.
     */
    components?: Record<string, string>

    /** Props required by a dynamic prompt. Present only for dynamic prompts. */
    props?: Array<{
        /** Prop name. */
        name: string
        /** TypeScript type string as written in `defineProps`. */
        type: string
        /** Whether the prop is required. */
        required?: boolean
    }>
}

/**
 * `prompt.config.ts` — a prompt package's marker.
 *
 * Deliberately EMPTY. A prompt has no dependencies, no build output and no
 * runtime surface: the folder's top-level .vue/.md files ARE the artifact.
 *
 * Identity (name, version, description) lives in package.json, which is what
 * publish actually reads — see `bundle/source.ts`. This type carried a
 * `description` that no code ever read, so a package could set it and watch
 * the registry list something else.
 *
 * The config FILE stays: its presence is how `detectKind()` identifies a
 * prompt package, and real per-prompt configuration is expected here.
 */
export type PromptConfig = Record<string, never>

/** Return shape produced by `definePrompt()`. */
export type PromptDefinition = {
    _kind: "prompt"
    config: PromptConfig
}
