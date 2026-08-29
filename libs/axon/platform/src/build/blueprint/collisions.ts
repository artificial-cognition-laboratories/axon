import type { ScanWarning } from "./types"

/**
 * Merge named surfaces with precedence: the agent always wins, then modules
 * in declaration order (first wins). Losers are skipped and reported —
 * a shadowed prompt is a warning the CLI shows, not a silent disappearance.
 */
export function merge<T extends { name: string }>(
    surface: string,
    agent: T[],
    modules: Array<{ owner: string; entries: T[] }>,
): { merged: T[]; warnings: ScanWarning[] } {
    const merged: T[] = []
    const warnings: ScanWarning[] = []
    const owners = new Map<string, string>()

    // The agent's own entries can collide with each other — two files in
    // src/tools/ both exporting `search`. Precedence cannot resolve that: there
    // is no "winner" rule between two files the same author wrote, and letting
    // both through would render two declarations of one global. First wins, and
    // the duplicate is reported so the author knows one of their exports is not
    // reachable.
    for (const entry of agent) {
        if (owners.has(entry.name)) {
            warnings.push({
                domain: surface,
                error: `"${entry.name}" is declared more than once by the agent — only the first is used`,
            })
            continue
        }
        owners.set(entry.name, "agent")
        merged.push(entry)
    }

    for (const group of modules) {
        for (const entry of group.entries) {
            const owner = owners.get(entry.name)
            if (owner) {
                warnings.push({
                    domain: surface,
                    error: `"${entry.name}" from module "${group.owner}" shadowed by ${owner === "agent" ? "the agent" : `module "${owner}"`} — skipped`,
                })
                continue
            }
            owners.set(entry.name, group.owner)
            merged.push(entry)
        }
    }

    return { merged, warnings }
}
