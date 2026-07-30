/**
 * The log-event convention: every event namespace can carry a
 * `<namespace>:log:<level>` event alongside its own vocabulary — kernel
 * telemetry can log, cognet can log, without a bespoke logging channel per
 * subsystem. A log pane derives
 * "is this a log line?" purely from the type suffix (`:log:info` /
 * `:log:warning` / `:log:error`), same as any other classification in
 * this system — see envelope.ts rule 3 ("classification comes from the
 * type namespace").
 *
 * `value` is deliberately `unknown`, not `string` — a log line may be a
 * plain message, a structured object, an array of args (console.log-style
 * variadic capture), anything. The log view renders whatever shape shows
 * up: a string prints as-is, anything else gets stringified/inspected.
 * Emitters are never forced to pre-format into text.
 */
export type AxonLogEvents<Namespace extends string> = {
    [K in `${Namespace}:log:info` | `${Namespace}:log:warning` | `${Namespace}:log:error`]: { value: unknown }
}

/** Every `:log:info` / `:log:warning` / `:log:error` suffix, regardless of namespace — the one place a log-classifying reader should derive this from. */
export const LOG_EVENT_SUFFIXES = [":log:info", ":log:warning", ":log:error"] as const

/** True for any event type following the `<namespace>:log:<level>` convention. */
export function isLogEventType(type: string): boolean {
    return LOG_EVENT_SUFFIXES.some(suffix => type.endsWith(suffix))
}
