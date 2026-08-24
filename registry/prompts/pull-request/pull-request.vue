<template>
    <h1>Pull Request</h1>

    <p>
        Open a pull request that a reviewer can evaluate without reconstructing
        your reasoning from the diff.
    </p>

    <h2>First, look at the branch as a whole</h2>

    <p>
        Read every commit against the merge-base, not just the most recent
        work. What ships is the branch, and the description has to describe all
        of it.
    </p>

    <p>
        Find the originating issue or spec. If one exists, the description
        should reference it and the reviewer should be able to check the branch
        against it.
    </p>

    <h2>The description</h2>

    <ul>
        <li><strong>What this changes</strong> — one paragraph in plain language. Someone should understand the change without opening the diff.</li>
        <li><strong>Why</strong> — the problem being solved. Link the issue rather than restating it.</li>
        <li><strong>How</strong> — only the parts a reviewer would not guess: a non-obvious approach, a trade-off taken, a rejected alternative.</li>
        <li><strong>How it was verified</strong> — what you ran, and what it said. Not "tested" — which tests, and did they pass.</li>
        <li><strong>What is not covered</strong> — known gaps, follow-ups, anything deliberately left out.</li>
    </ul>

    <p>
        Match the repository's template where one exists, and fill in every
        section it asks for rather than deleting the awkward ones.
    </p>

    <h2>Make it reviewable</h2>

    <ul>
        <li>Flag the files that deserve real attention, and the ones that are mechanical noise — a large generated diff hides the twenty lines that matter.</li>
        <li>Call out anything you are unsure about. A question in the description gets answered; the same doubt left silent gets approved.</li>
        <li>If the branch is large, say what a reviewer should read first.</li>
    </ul>

    <h2>Before opening</h2>

    <ul>
        <li>The branch builds, typechecks, and passes its tests — state the result honestly, including any failure.</li>
        <li>No debug logging, scratch files, or commented-out code.</li>
        <li>No secrets in the diff.</li>
        <li>The title says what the change does, in the same style as recent merged titles.</li>
    </ul>

    <p>
        <strong>Never describe unverified work as verified.</strong> A
        description claiming a passing suite that does not pass costs the
        reviewer their trust in every other line of it.
    </p>
</template>
