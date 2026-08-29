/**
 * Surgical text editing primitives.
 *
 * The manifest files an agent owns — axon.config.ts, bunfig.toml — are files a
 * HUMAN wrote and reads. Every edit here is deliberately textual rather than an
 * AST or TOML round-trip: reprinting from a parse tree would reformat their
 * code and lose their comments. The edits are narrow enough to be exact, and
 * refuse to guess when they are not.
 *
 * That makes regex construction a shared concern of every editor, which is why
 * this exists — `escape` was previously copied byte-for-byte into both
 * config.ts and bunfig.ts.
 */
export const text = {
    /** Escape a value for literal use inside a RegExp. */
    escape(value: string): string {
        return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    },
}
