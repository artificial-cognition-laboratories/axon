<template>
    <h1>Refactor</h1>

    <p>
        Improve the structure of code without changing what it does. The
        constraint <em>is</em> the discipline: behaviour before and after must
        be identical, and you must be able to demonstrate it.
    </p>

    <h2>1. Establish the safety net first</h2>

    <p>
        Find the tests covering the code you are about to change. Run them and
        watch them pass.
    </p>

    <p>
        <strong>If there is no coverage, that is step one.</strong> Write
        characterisation tests that pin the current behaviour — including
        behaviour that looks wrong. You are not fixing anything yet; you are
        recording what is true, so a change in it is detectable. Refactoring
        without a net is not refactoring, it is rewriting and hoping.
    </p>

    <h2>2. Name the specific improvement</h2>

    <p>
        State what is wrong and what will be better in one sentence before
        starting. "This function does three unrelated things and no caller
        needs the third" is actionable. "Clean this up" is not, and produces
        diffs nobody can review.
    </p>

    <p>
        If you cannot name the improvement, do not refactor. Restructuring
        without a stated goal is churn that costs a review and buys taste.
    </p>

    <h2>3. Work in small, reversible steps</h2>

    <ul>
        <li>One transformation at a time — extract, inline, rename, move, change a signature.</li>
        <li>Run the tests after each one. Not at the end.</li>
        <li>Keep every step committable. A refactor that only works once fully finished cannot be reviewed or abandoned.</li>
        <li>Prefer the tooling's automated rename and extract where available — it does not typo.</li>
    </ul>

    <h2>Rules</h2>

    <ul>
        <li>
            <strong>Never change behaviour and structure in the same
            commit.</strong> This is the whole discipline. A diff that moves
            code and alters logic cannot be reviewed: the reader cannot tell
            the intentional change from the accident.
        </li>
        <li>
            <strong>Bugs found mid-refactor get noted, not fixed.</strong>
            Finish the restructuring, then fix the bug in its own commit — with
            its own test.
        </li>
        <li>
            <strong>Do not rename things you are not otherwise touching.</strong>
            A drive-by rename across forty files buries the actual change.
        </li>
        <li>
            <strong>Stop if the tests go red and you do not immediately know
            why.</strong> Revert to the last green step rather than debugging
            forward through a half-applied restructuring.
        </li>
        <li>
            <strong>Do not add abstraction for a need that does not exist
            yet.</strong> Speculative generality is a defect, not a
            refactoring.
        </li>
    </ul>

    <h2>Report</h2>

    <p>
        What changed structurally, what stayed identical behaviourally, and how
        you know — which tests ran, and that they passed before and after. If
        anything about the behaviour did change, however small, lead with that.
    </p>
</template>
