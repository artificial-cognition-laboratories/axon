/**
 * Activity — the closed vocabulary of renderable agent activities.
 *
 * An activity is a human-meaningful action a tool performed ("patched a
 * file", "ran a process"), emitted from INSIDE the tool body via the
 * capsule's ambient `axon.activity()` — implementation-independent: the
 * payload is the RENDER contract, never a tool's args or return type, so
 * any tool that patches a file emits the same `file:patch` regardless of
 * how it did it.
 *
 * Stability contract (tool authors depend on this from userland code):
 * the vocabulary is additive-only — new types may be added, existing
 * payload fields never change meaning. A renderer meeting an unknown
 * type falls back to a generic key-value row, it never errors.
 *
 * Lifecycle: two phases on the wire. "declared" opens the row (in-flight),
 * "done"/"failed" settles it. Declare may carry a partial payload (path
 * only); settle merges the rest (the diff). The capsule auto-settles
 * anything still open when its command ends — failed if the command
 * threw — so the error path costs tool authors nothing.
 */
export type ActivityPayloads = {
    "file:read": { path: string; range?: [from: number, to: number] }
    "file:write": { path: string; bytes?: number }
    /**
     * `before`/`after` are HUNK-SCOPED excerpts (the changed region plus a
     * few context lines), never the whole file — payloads stay bounded.
     * The renderer diffs and presents them (TUI: the native diff element);
     * tool authors ship facts, not formatting.
     */
    "file:patch": { path: string; before?: string; after?: string }
    "file:delete": { path: string }
    "file:move": { from: string; to: string }
    "file:search": { query: string; scope?: string; matches?: number }
    "proc:exec": { command: string; cwd?: string; exitCode?: number }
    "http": { method: string; url: string; status?: number }
    "speech": { text: string }
    /** Escape hatch — a plain sentence for anything outside the vocabulary. */
    "note": { text: string }
}

export type ActivityType = keyof ActivityPayloads

export type ActivityPhase = "declared" | "done" | "failed"

/** One activity emission as recorded on the wire and in the session log. */
export type Activity<T extends ActivityType = ActivityType> = T extends ActivityType
    ? {
          /** Unique per emission — pairs the declare with its settle. */
          id: string
          /** The vocabulary type. `activity`, not `type` — events own `type`. */
          activity: T
          phase: ActivityPhase
          /** Declared may be partial; the settle carries the remainder. */
          data: Partial<ActivityPayloads[T]>
          /** Present when phase is "failed". */
          error?: string
      }
    : never

/**
 * The ambient the capsule installs as `globalThis.axon` for tool code.
 * Write-only, fire-and-forget telemetry — returns nothing but the settle
 * handle, grants nothing. Absent outside the capsule; tools guard with
 * `globalThis.axon?.` and stay unit-testable as plain modules.
 */
export type AxonAmbient = {
    activity<T extends ActivityType>(
        type: T,
        data?: Partial<ActivityPayloads[T]>,
    ): ActivityHandle<T>
}

export type ActivityHandle<T extends ActivityType = ActivityType> = {
    /** Settle the activity with the rest of its payload. Idempotent. */
    done(data?: Partial<ActivityPayloads[T]>): void
}
