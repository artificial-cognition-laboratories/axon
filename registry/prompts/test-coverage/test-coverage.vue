<template>
    <h1>Test Coverage</h1>

    <p>
        Find what is untested and worth testing, then close the gaps that
        matter. The goal is confidence, not a percentage.
    </p>

    <p>
        <strong>Coverage is a map of what was executed, not what was
        verified.</strong> A line runs during a test that asserts nothing about
        it and counts as covered. Treat the number as a way to find blind
        spots, never as a target — chasing a figure produces tests that
        exercise code without checking it, which is worse than no test, because
        it looks like protection.
    </p>

    <h2>1. See where you are</h2>

    <p>
        Run the project's coverage tooling. Read it by module rather than in
        aggregate: a repo at seventy percent might have a fully-tested core and
        an untouched payment path, and the aggregate hides exactly the thing
        you need to know.
    </p>

    <h2>2. Rank the gaps by what a bug would cost</h2>

    <p>Untested code is not uniformly risky. In descending order:</p>

    <ul>
        <li><strong>Money, auth, and data integrity</strong> — where a bug is expensive or unrecoverable.</li>
        <li><strong>Complex logic</strong> — branching, edge cases, state machines. Where bugs actually live.</li>
        <li><strong>Recently changed and frequently changed code</strong> — churn predicts defects better than almost anything else.</li>
        <li><strong>Bug-prone areas</strong> — anywhere that has been fixed twice already.</li>
        <li><strong>Public interfaces</strong> — the contracts other code depends on.</li>
    </ul>

    <p>
        Correspondingly, do not spend effort on generated code, thin
        pass-through wrappers, configuration, or code that will be deleted.
        Untested trivial code is fine.
    </p>

    <h2>3. Write tests that could fail</h2>

    <p>
        Test behaviour through public interfaces, at seams agreed before you
        start. For each gap, ask what would break if this code were wrong, and
        assert on <em>that</em> — not on the code's current output.
    </p>

    <p>
        Every new test must be watched failing before it is trusted. Break the
        code deliberately, see the test go red, restore it. A test that has
        never failed is an assumption, and this is the one moment it costs
        nothing to check.
    </p>

    <p>Prioritise, in this order:</p>

    <ol>
        <li>The path that actually matters working end to end.</li>
        <li>The error and edge cases — empty, boundary, malformed, concurrent.</li>
        <li>The regressions: every historical bug in this area, pinned.</li>
    </ol>

    <h2>4. Report</h2>

    <ul>
        <li>What was untested and now is, with what each test protects.</li>
        <li>What is still untested and deliberately so, with the reason.</li>
        <li>Anywhere the code was too tangled to test at a sensible seam — that is a design finding, and more valuable than the tests.</li>
    </ul>

    <p>
        Never report a coverage increase as the outcome. Report what is now
        protected that was not.
    </p>
</template>
