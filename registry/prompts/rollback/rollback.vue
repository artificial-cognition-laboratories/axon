<template>
    <h1>Rollback</h1>

    <p>
        Undo a change safely. Rolling back is not the reverse of deploying —
        it has its own hazards, and the ones that bite are almost always about
        state, not code.
    </p>

    <h2>1. Confirm rollback is the right move</h2>

    <p>
        It usually is: reverting to a known-good state is faster and more
        predictable than fixing forward under pressure. But check the two cases
        where it is not:
    </p>

    <ul>
        <li><strong>The old version cannot read the new data.</strong> If a migration ran and the previous code does not understand the schema, rolling back the code alone breaks it differently.</li>
        <li><strong>The change is already load-bearing.</strong> If other work has been built on top since, reverting may break more than it fixes.</li>
    </ul>

    <h2>2. Work out what state has moved</h2>

    <p>
        This is where rollbacks go wrong. Code reverts cleanly; the world does
        not. Before reverting, establish:
    </p>

    <ul>
        <li>Did a schema migration run? Is it reversible, and is reversing it lossy?</li>
        <li>Was data written in a new shape that the old code will misread?</li>
        <li>Were messages published, jobs enqueued, or webhooks sent that the old version cannot handle?</li>
        <li>Did anything external change — a third-party configuration, a DNS record, a permission?</li>
        <li>Are there caches holding data in the new shape?</li>
    </ul>

    <p>
        Anything written while the bad version was live still exists after the
        rollback. Decide explicitly what happens to it: leave it, migrate it,
        or quarantine it.
    </p>

    <h2>3. Prefer reverting to rewriting history</h2>

    <p>
        Add a commit that undoes the change rather than removing it from
        history. Anyone who already pulled keeps a consistent view, and the
        record of what happened stays intact — including the fact that it was
        reverted, which is genuinely useful information later.
    </p>

    <p>
        Revert the whole change, not selected parts. A partial revert produces
        a state that was never tested and that nobody has a mental model of.
    </p>

    <h2>4. Verify against the original symptom</h2>

    <p>
        Confirm the specific problem is gone — not merely that the deploy
        succeeded. Then check the things a rollback commonly breaks: anything
        depending on the reverted behaviour, and anything that wrote data in
        the new shape.
    </p>

    <h2>5. Write down what happened</h2>

    <p>
        Record what was reverted, why, what state was left behind, and what
        must be true before it can be attempted again. Without that, the same
        change is redeployed later by someone who does not know it failed.
    </p>

    <p>
        A reverted change is not a failure. Reverting quickly is a functioning
        system; leaving something broken while attempting a fix under pressure
        is not.
    </p>
</template>
