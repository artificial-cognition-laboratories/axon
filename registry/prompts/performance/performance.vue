<template>
    <h1>Performance</h1>

    <p>
        Make something measurably faster. The discipline is entirely in the
        order: measure, find the real cost, change one thing, measure again.
    </p>

    <p>
        <strong>Never optimise from a reading of the code.</strong> Intuition
        about where time goes is wrong often enough that acting on it usually
        costs a day and buys nothing. If you have not measured, you do not know.
    </p>

    <h2>1. Get a number</h2>

    <p>
        Establish what "slow" means here, concretely: which operation, under
        what input, how long it currently takes, and what would count as fixed.
        "The dashboard is slow" is not actionable; "the dashboard takes 4s to
        first paint with 500 rows, and should be under 1s" is.
    </p>

    <p>
        Build a repeatable measurement before touching anything — a benchmark,
        a timed script, a profiler run. It must be deterministic enough that a
        ten percent change is distinguishable from noise. Run it several times
        and know the variance.
    </p>

    <h2>2. Find where the time actually goes</h2>

    <p>
        Profile. Read the profile top-down: the biggest block of time first,
        not the code that looks worst. Keep asking "what is this waiting on?"
        until you reach something you can change.
    </p>

    <p>The usual answers, roughly in order of how often they turn out to be it:</p>

    <ul>
        <li><strong>Repeated work</strong> — the same computation or request performed in a loop that could happen once.</li>
        <li><strong>N+1 access</strong> — one query or call per item where one call for all items would do.</li>
        <li><strong>Doing too much</strong> — fetching, parsing, or rendering far more data than the operation needs.</li>
        <li><strong>Waiting serially</strong> — independent operations awaited one after another rather than together.</li>
        <li><strong>The wrong shape</strong> — a linear scan where a lookup belongs, or a data structure rebuilt on every access.</li>
        <li><strong>The algorithm</strong> — genuinely quadratic behaviour that only shows up at real input sizes.</li>
    </ul>

    <p>
        For anything involving a database, read the query plan before touching
        the query. A missing index is both the most common cause and the
        cheapest fix.
    </p>

    <h2>3. Change one thing</h2>

    <p>
        One change, then re-measure. Batching three optimisations together
        means you learn nothing about which one worked — and one of them is
        usually a regression hidden by the other two.
    </p>

    <p>
        Keep behaviour identical. A faster function returning different results
        is not an optimisation. Run the tests after each change.
    </p>

    <h2>4. Report honestly</h2>

    <ul>
        <li>Before and after, with the same measurement, stated as numbers.</li>
        <li>What the change was, and why it worked.</li>
        <li>What it cost — added complexity, memory, cache invalidation, readability.</li>
        <li>What you tried that did not help. This is worth as much as what did.</li>
    </ul>

    <p>
        <strong>Stop when it is fast enough.</strong> Performance work has
        diminishing returns and a rising complexity cost; the goal set in step
        one is the finish line, not an invitation to keep going.
    </p>

    <p>
        If the honest answer is "the profile is flat and there is no single
        hotspot", say so. That is a real finding, and it usually means the fix
        is architectural rather than local.
    </p>
</template>
