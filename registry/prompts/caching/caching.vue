<template>
    <h1>Caching</h1>

    <p>
        Add a cache without introducing a correctness bug. Caching trades
        freshness for speed, and the cost is almost always paid later, by
        someone debugging why two parts of the system disagree.
    </p>

    <h2>Do not cache first</h2>

    <p>
        A cache is the second answer. First check whether the work can be
        avoided, batched, indexed, or made cheaper — those fixes do not add
        state, do not go stale, and do not need invalidating.
    </p>

    <p>
        And measure before adding one. Caching something that was never the
        bottleneck adds a whole class of bugs in exchange for nothing.
    </p>

    <h2>Answer these before writing any code</h2>

    <ul>
        <li><strong>How stale can this be?</strong> A real number. "Fresh" means no cache; if seconds are acceptable, say how many. This single answer determines the whole design.</li>
        <li><strong>What happens if it is wrong?</strong> A stale display name is cosmetic. A stale permission check is a security bug. The tolerable staleness for anything governing access is usually zero.</li>
        <li><strong>What invalidates it?</strong> Every write path that could change the underlying value. Miss one and it goes stale permanently.</li>
        <li><strong>What is the key?</strong> Everything the value depends on must be in it — including the identity of the caller where results differ per user. A key missing a dimension serves one user's data to another.</li>
    </ul>

    <p>
        That last one deserves particular care: a cache keyed on the resource
        but not the viewer is one of the most common and most serious caching
        bugs there is.
    </p>

    <h2>Prefer expiry to invalidation</h2>

    <p>
        A short time-to-live is simple, self-healing, and bounded in how wrong
        it can be. Explicit invalidation is precise but must be correct
        everywhere forever — every future write path has to remember it.
    </p>

    <p>
        Use expiry where the staleness window is acceptable. Add explicit
        invalidation only where it is not, and treat every new write path as
        something that must be checked against it.
    </p>

    <h2>Failure modes</h2>

    <ul>
        <li><strong>Caching errors and empty results.</strong> A failure cached for an hour turns a blip into an outage.</li>
        <li><strong>Stampede.</strong> Everything expiring at once and hitting the origin together. Jitter the expiry.</li>
        <li><strong>Unbounded growth.</strong> A cache with no size limit is a memory leak with a helpful name.</li>
        <li><strong>Caching per-user data in a shared cache</strong> without the user in the key.</li>
        <li><strong>Layered caches</strong> with different lifetimes, so the system disagrees with itself and no single flush fixes it.</li>
        <li><strong>Hard dependency on the cache.</strong> If it being unavailable takes the system down, it is not a cache — it is a database with no durability.</li>
    </ul>

    <h2>Make it observable</h2>

    <p>
        Hit rate, and a way to see whether a specific value is cached and how
        old it is. Without that, "is this stale?" cannot be answered during an
        incident — and it is the question that will be asked.
    </p>
</template>
