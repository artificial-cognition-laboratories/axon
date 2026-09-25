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

/**
 * A transport a test hands to ONE Platform, and can re-point mid-test.
 *
 * The replacement for `globalThis.fetch = stub`. That works only if nothing
 * else is running, and `bunfig.toml` sets `parallel = true` — Bun interleaves
 * test FILES in a single process, so a global stub is live inside every other
 * file executing at that moment. It was not hypothetical: `switch.test.ts`'s
 * 401 fixture surfaced as "Unauthorized: invalid or expired token" in 65
 * unrelated tests, and a clone fixture served another suite a tarball of a
 * directory it had already deleted. ~220 failures, none of them real.
 *
 * A save-and-restore wrapper cannot fix that — the stub has to be live while
 * the body runs, and under concurrency that window belongs to everyone. Only a
 * seam owned by one instance is isolated, so this is passed as
 * `Platform({ fetch: net.fetch })` and nothing global is touched.
 *
 * `fetch` is a stable delegate rather than the current stub, so a Platform
 * constructed once keeps working across every `use()` — which is what lets a
 * test watch one client go from valid to revoked.
 */
export function Transport(initial: typeof fetch = fetch) {
    let current = initial

    return {
        /** Pass this to `Platform({ fetch })` — it never changes identity. */
        fetch: stubFetch(async (input, init) => current(input as string, init as RequestInit)),
        /**
         * Point the transport at `stub` until the returned restore is called.
         *
         * For a test whose stub outlives a single block — it installs a
         * backend, drives several calls, then restores. `with()` is preferred
         * where the scope IS a block, because it restores on a throw.
         */
        use(stub: typeof fetch): () => void {
            const previous = current
            current = stub
            return () => { current = previous }
        },
        /** Point the transport at `stub` for the duration of `body`. */
        async with(stub: typeof fetch, body: () => Promise<void>): Promise<void> {
            const previous = current
            current = stub
            try {
                await body()
            } finally {
                current = previous
            }
        },
    }
}

export type TransportT = ReturnType<typeof Transport>
