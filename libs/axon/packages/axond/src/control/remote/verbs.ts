import type { RemoteT } from "./remote"

/**
 * The remote surface's verbs, by name — what a client builds `machines.at(key)`
 * from without loading the domains `Remote` wraps.
 *
 * Checked against `RemoteT` both ways at compile time: a verb named here that
 * `Remote` lacks fails `satisfies`, and a verb `Remote` gains that is missing
 * here fails `Exhaustive` below. The table cannot drift from the surface.
 */
export const REMOTE_VERBS = {
    machine: ["state"],
    agents: ["list", "installed", "stop"],
    schedule: ["list", "pause", "resume"],
    models: ["state"],
} as const satisfies { [D in keyof RemoteT]: readonly (keyof RemoteT[D])[] }

type Listed = typeof REMOTE_VERBS
type Exhaustive = { [D in keyof RemoteT]: Exclude<keyof RemoteT[D], Listed[D][number]> }[keyof RemoteT]
// If this line errors, a verb was added to Remote and not to REMOTE_VERBS.
const exhaustive: [Exhaustive] extends [never] ? true : Exhaustive = true
void exhaustive

/** One verb as a client calls it: the remote verb's own argument and answer. */
type Verb<F> = F extends (...args: infer A) => Promise<infer R> ? (...args: A) => Promise<R> : never

/** Another machine's remote surface, as a client holds it. */
export type RemoteClient = { [D in keyof RemoteT]: { [V in keyof RemoteT[D]]: Verb<RemoteT[D][V]> } }

/**
 * Build a `RemoteClient` from the verb table over one `call`. The single cast
 * is the wire: `call` answers `unknown`, and the table is what ties each name
 * to its type.
 */
export function remoteClient(call: (path: readonly string[], arg?: unknown) => Promise<unknown>): RemoteClient {
    const client: Record<string, Record<string, (arg?: unknown) => Promise<unknown>>> = {}
    for (const [domain, verbs] of Object.entries(REMOTE_VERBS)) {
        client[domain] = Object.fromEntries(verbs.map(verb => [verb, (arg?: unknown) => call([domain, verb], arg)]))
    }
    return client as RemoteClient
}
