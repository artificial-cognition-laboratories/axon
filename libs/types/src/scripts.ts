
/** Script discovered from `src/scripts/` or an installed module. */
export type AxonScript = {
    /** Script name used with `axon.scripts.request(name)`. */
    name: string
    /** Human-readable script summary. */
    description?: string
    /**
     * Absolute path to the script file. Set during discovery so the runtime
     * can load the file without re-deriving the path from the name convention.
     */
    filePath?: string
    args?: Array<{
        /** Argument name. */
        name: string
        /** TypeScript type string as written in `defineArgs`. */
        type: string
        /** Whether the argument is required. */
        required?: boolean
    }>
}