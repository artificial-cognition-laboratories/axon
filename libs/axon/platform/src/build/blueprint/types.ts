import type { AxonError } from "@arcforge/err"
/**
 * Blueprint-internal types. The entry shapes themselves (AxonPrompt,
 * AxonScript, AxonTool, AxonRoute, AxonModule) are canonical in @arcforge/types —
 * there is no separate "manifest" layer anymore.
 */

/** A non-fatal discovery problem. Scanners warn; only Config throws. */
export type ScanWarning = {
    domain: string
    /** Flattened message — every consumer can print this. */
    error: string
    /**
     * The structured failure, when the scanner had one.
     *
     * Kept BESIDE the string rather than replacing it: a warning is not always
     * an AxonError (a shadowed tool name is a sentence, not a throw), and a
     * renderer must not have to branch on which kind it got just to show a
     * line. The string is the contract; this is the upgrade.
     */
    cause?: AxonError
}

/** What every scanner returns: entries plus whatever it couldn't read. */
export type Scanned<T> = {
    entries: T[]
    warnings: ScanWarning[]
}
