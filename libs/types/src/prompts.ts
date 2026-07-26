
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