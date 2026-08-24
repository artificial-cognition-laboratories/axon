/**
 * One catalogued knowledge file, as the BUILD sees it.
 *
 * Distinct from the kernel's `KnowledgeEntry` (the shape a cognet reads)
 * exactly as `AxonPrompt` is distinct from a rendered prompt: this carries
 * where the file physically is and who contributed it, and the kernel's
 * carries only what a brain may know. The absolute path lives here and
 * stops here.
 *
 * Discovered at build time so a module's corpus never has to be COPIED into
 * the agent installing it. Copying would fork the material on the first
 * update and duplicate megabytes into every agent; a blueprint entry keeps
 * one copy in the module and lets `axon update` refresh it.
 */
export type AxonKnowledge = {
    /**
     * The name a cognet addresses this by — already namespaced for module
     * material, so an agent's own `axon/agent.md` and a module's can coexist.
     */
    name: string
    /** Frontmatter `description`, falling back to `title`. Empty when neither. */
    description: string
    /** Bytes on disk, read during the scan that found the file. */
    size: number
    /** Absolute path. Build- and kernel-side only; never rendered to a model. */
    path: string
    /**
     * Who contributed it. The one field that decides writability: an agent's
     * own store is writable, a module's is not — its files live under
     * node_modules and would be destroyed by the next install, silently
     * losing whatever the agent wrote there.
     */
    origin: "agent" | "module"
    /** The contributing module's name. Absent for the agent's own material. */
    module?: string
}
