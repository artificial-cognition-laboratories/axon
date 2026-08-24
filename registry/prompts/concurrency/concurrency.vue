<template>
    <h1>Concurrency</h1>

    <p>
        Reason about code where more than one thing happens at once. Approach
        this with more suspicion than sequential code: concurrency bugs are
        rare in testing, common in production, and almost never reproduce on
        demand.
    </p>

    <p>
        <strong>Assume you have missed something.</strong> The failure mode
        here is confidence — concurrent code that looks obviously correct is
        exactly the code that deadlocks under load six weeks later. If you have
        not explicitly reasoned about interleaving, you have not checked it.
    </p>

    <h2>Find the shared mutable state</h2>

    <p>
        Every concurrency bug requires two things: state reachable from more
        than one place, and at least one writer. Start by listing what is
        shared — module-level variables, caches, connection pools, files,
        database rows, anything held across an await.
    </p>

    <p>
        The strongest move available is usually to eliminate the sharing rather
        than to guard it. State confined to one owner, or passed by value,
        cannot race.
    </p>

    <h2>What to look for</h2>

    <ul>
        <li>
            <strong>Check-then-act.</strong> Reading a value, deciding based on
            it, then acting — where something else can change it in between.
            "If it doesn't exist, create it" is the classic, and it produces
            duplicates under load.
        </li>
        <li>
            <strong>Read-modify-write.</strong> Any increment, append, or
            update that is not atomic. Two concurrent updates and one is lost.
        </li>
        <li>
            <strong>State held across a suspension point.</strong> Anything
            read before an await and used after it may be stale — the world
            moved while you were suspended.
        </li>
        <li>
            <strong>Lock ordering.</strong> Two locks acquired in different
            orders in different paths is a deadlock waiting for the right
            timing.
        </li>
        <li>
            <strong>Unbounded concurrency.</strong> Firing off work per item
            with no limit exhausts connections, memory, or rate limits at a
            scale you did not test at.
        </li>
        <li>
            <strong>Assumed ordering.</strong> Concurrent operations completing
            in the order they were started — they do not.
        </li>
        <li>
            <strong>Non-idempotent retries.</strong> Retrying an operation that
            partially succeeded, doing the completed half twice.
        </li>
    </ul>

    <h2>Preferences</h2>

    <ul>
        <li>Push atomicity down to whatever already provides it — a database transaction, a compare-and-swap, a unique constraint — rather than building it in application code.</li>
        <li>Make operations idempotent, so retries and duplicate delivery stop being correctness problems.</li>
        <li>Bound everything: concurrency limits, queue sizes, timeouts.</li>
        <li>Prefer immutable data and message passing over shared mutable state with locks.</li>
    </ul>

    <h2>Verifying</h2>

    <p>
        A passing test proves very little here — the interleaving that breaks
        may occur once in ten thousand runs. Where it matters, raise the
        probability deliberately: run the operation many times in parallel,
        inject delays at suspension points, and use whatever race detection the
        platform offers.
    </p>

    <p>
        State your reasoning explicitly when reporting: what is shared, what
        guarantees atomicity, and what happens under the interleavings you
        considered. If there is an interleaving you cannot rule out, say so
        rather than assuming it is fine.
    </p>
</template>
