import type { ProviderEntry } from "@arcforge/types"

/**
 * What a profile that has never declared providers gets.
 *
 * The managed route alone: it needs no connection beyond being signed in,
 * supplies the full catalogue, and is what `axon init` writes into a fresh
 * profile. Anything more would be guessing at credentials a user may not
 * have; anything less is the crash this exists to prevent.
 *
 * A DEFAULT, deliberately, and not an implicit provider like mock below.
 * Axon is billed, so "always present" would remove the only way to say *do
 * not use my Axon account for this agent*: `providers: [Ollama()]` has to
 * keep meaning Ollama and nothing else. A user gets it by default and can
 * remove it by declaring anything at all — which is the opt-out, and the one
 * provider that most needs one.
 */
const DEFAULT_PROVIDERS: readonly ProviderEntry[] = [{ provider: "axon" }]

/**
 * Providers present in EVERY pool, declared or not.
 *
 * Only mock, and the distinction from the default above is the whole point.
 *
 * Mock needs no credential, reaches no network, does no I/O and costs
 * nothing. There is no statement a user could make that "no mock" is the
 * sensible reading of, and nothing to opt out of — so requiring a declaration
 * only made the test double unreachable at exactly the moment something is
 * broken enough to want one.
 *
 * Appended LAST, so a declared `Mock(...)` overrides it rather than
 * duplicating it: the dedup below is first-wins, and order here is preference
 * order among candidates that all satisfy a role — something nobody asked for
 * must not outrank something somebody did.
 */
const IMPLICIT_PROVIDERS: readonly ProviderEntry[] = [
    { provider: "mock" },
    // This machine is always a valid inference boundary and is never billed.
    // A declared Local(...) appears earlier and therefore overrides this entry.
    { provider: "local" },
]

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
    // refuses to boot. So absent takes the default: the managed route.
    //
    // An EMPTY array is a real answer and is honoured. A user who cleared
    // their providers has removed Axon deliberately, and gets exactly that.
    // The agent still boots — mock is implicit and can fill an ordinary text
    // role — which is the right outcome for a cognet that needs no LLM at
    // all: a control loop asks for nothing, and refusing to start it because
    // no inference was declared assumes a model this system does not require.
    const declared = profile ?? DEFAULT_PROVIDERS

    const pool: ProviderEntry[] = []
    const seen = new Set<string>()

    // Declared first, implicit last. "First wins" is what makes a declaration
    // an OVERRIDE rather than a duplicate: a user's own `Mock(...)` is the
    // entry that lands, and the implicit one is skipped.
    for (const entry of [...declared, ...(agent ?? []), ...IMPLICIT_PROVIDERS]) {
        if (seen.has(entry.provider)) continue
        seen.add(entry.provider)
        pool.push(entry)
    }

    return pool
}
