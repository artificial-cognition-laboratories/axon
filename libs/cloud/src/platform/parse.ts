/**
 * Wire-boundary parse helpers — pin one camelCase shape per endpoint and
 * throw with a named field on drift. Deliberately minimal: if these ever
 * grow coercion ("accept string or number"), fix the backend instead.
 * Shelved successor: schema-defined contract shared with the backend.
 */

export function record(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`invalid response: ${label} is not an object`)
    }
    return value as Record<string, unknown>
}

export function rows(value: unknown, label: string): Record<string, unknown>[] {
    if (!Array.isArray(value)) throw new Error(`invalid response: ${label} is not an array`)
    return value.map(v => record(v, `${label} entry`))
}

export function str(data: Record<string, unknown>, key: string): string {
    const value = data[key]
    if (typeof value !== "string") throw new Error(`invalid response: missing "${key}"`)
    return value
}

export function num(data: Record<string, unknown>, key: string): number {
    const value = data[key]
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`invalid response: missing "${key}"`)
    return value
}

export function bool(data: Record<string, unknown>, key: string): boolean {
    const value = data[key]
    if (typeof value !== "boolean") throw new Error(`invalid response: missing "${key}"`)
    return value
}

export function strOrNull(data: Record<string, unknown>, key: string): string | null {
    const value = data[key]
    return typeof value === "string" ? value : null
}
