/**
 * A stubbed `globalThis.fetch` for a test that never makes a real request.
 *
 * Bun's `fetch` carries `preconnect` alongside the call signature, so a bare
 * arrow function is not assignable to `typeof fetch` and every stub site grew
 * its own `as` cast. One helper states the narrowing once, in the place whose
 * job is to describe it, rather than eleven times in the tests that use it.
 *
 * The cast is honest: a stub genuinely is not a `fetch`, and the tests that
 * install one exercise the code path ABOVE the network. Anything that needs a
 * real response shape should build a real `Response`, which this still allows.
 */
export function stubFetch(impl: (input?: unknown, init?: unknown) => Promise<Response>): typeof fetch {
    return impl as unknown as typeof fetch
}
