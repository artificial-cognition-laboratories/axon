import type { ProviderEntry } from "@arcforge/types"

/**
 * What a profile that has never declared providers gets.
 *
 * The managed route alone: it needs no connection beyond being signed in,
 * supplies the full catalogue, and is what `axon init` writes into a fresh
 * profile. Anything more would be guessing at credentials a user may not
 * have; anything less is the crash this exists to prevent.
 */
const DEFAULT_PROVIDERS: readonly ProviderEntry[] = [{ provider: "axon" }]

/**
 * The inference pool one agent runs against: the user's profile providers,
 * plus whatever the agent declares for itself.
 *
 * PROFILE FIRST, and the order is the preference order among candidates that
 * all satisfy a role — so a user's own declaration outranks an agent's when
 * both can serve. An agent may ADD a source its user would not otherwise
 * have; it can never displace or remove one, because the machine belongs to
 * the person running it and an installed agent quietly rerouting their
 * inference is the failure mode this whole split exists to prevent.
 *
 * Deduplicated by provider name, first wins. A user who set `slots` on their
 * own `Axon()` keeps that ceiling even if the agent ships an unbounded one —
 * again, the user's ceiling is the real one.
 */
export function providerPool(
    profile: readonly ProviderEntry[] | undefined,
    agent: readonly ProviderEntry[] | undefined,
): ProviderEntry[] {
    // NOT CONFIGURED is not the same as NONE.
    //
    // A profile with no `providers:` has never been asked the question —
    // every profile written before the field existed is in this state — and
    // answering "you have no inference" for it means every one of them
    // refuses to boot. So absent takes the default: the managed route, which
    // needs no setup beyond being signed in and is what a scaffolded profile
    // would have declared anyway.
    //
    // An EMPTY array is a real answer and is honoured. A user who cleared
    // their providers gets exactly that, and the boot fails loudly naming the
    // roles nothing can fill — which is correct, and reachable only
    // deliberately.
    const declared = profile ?? DEFAULT_PROVIDERS

    const pool: ProviderEntry[] = []
    const seen = new Set<string>()

    for (const entry of [...declared, ...(agent ?? [])]) {
        if (seen.has(entry.provider)) continue
        seen.add(entry.provider)
        pool.push(entry)
    }

    return pool
}
