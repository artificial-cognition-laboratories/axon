<template>
    <h1>Cleanup</h1>

    <p>
        Remove what should not ship: debug instrumentation, dead code, stale
        comments, and scratch files. The discipline is knowing the difference
        between unused and unreachable — deleting the wrong thing is worse than
        leaving noise.
    </p>

    <h2>What comes out</h2>

    <ul>
        <li><strong>Debug instrumentation</strong> — temporary logging, print statements, timers, breakpoint helpers added while working. Tagged instrumentation is easiest: find it by its prefix.</li>
        <li><strong>Commented-out code.</strong> Version control remembers it; a commented block only raises questions about whether it matters.</li>
        <li><strong>Scratch files</strong> — throwaway scripts, sample data, prototypes, notes that were never meant to ship.</li>
        <li><strong>Unused imports, variables, and parameters</strong> left behind by edits.</li>
        <li><strong>Stale comments</strong> — anything describing behaviour that no longer exists. A wrong comment is worse than none, because it is trusted.</li>
        <li><strong>Skipped or empty tests</strong> that nobody intends to restore.</li>
        <li><strong>Placeholder values</strong> — hardcoded test data, temporary credentials, "TODO: fix before merge".</li>
    </ul>

    <h2>Dead code needs proof</h2>

    <p>
        "I cannot find a caller" is not the same as "there is no caller". Before
        deleting anything more than a local variable, check for the ways it
        might be reached without a static reference:
    </p>

    <ul>
        <li>Dynamic access — by string name, reflection, or a registry.</li>
        <li>Exported public surface, which external consumers may use.</li>
        <li>Referenced from configuration, templates, or scripts rather than code.</li>
        <li>Used by tests, tooling, or build steps rather than the application.</li>
        <li>Entry points invoked by the platform rather than by your code.</li>
    </ul>

    <p>
        When in doubt, report it as a candidate rather than deleting it. A
        suggestion costs someone a minute; a wrong deletion costs an incident.
    </p>

    <h2>Rules</h2>

    <ul>
        <li>
            <strong>Cleanup is its own change.</strong> Never mix deletions
            into a feature or fix — they make the diff unreviewable and the
            revert impossible.
        </li>
        <li>
            <strong>Run the tests after.</strong> Removing an import with a
            side effect, or a variable something depended on, is exactly the
            kind of mistake cleanup makes.
        </li>
        <li>
            <strong>Do not reformat while cleaning.</strong> A cleanup diff
            with formatting churn hides what was actually removed.
        </li>
        <li>
            <strong>Keep intentional oddities.</strong> A workaround with a
            comment explaining why is not clutter — it is a load-bearing
            explanation.
        </li>
    </ul>

    <p>
        Report what was removed and why, and list separately anything you
        suspect is dead but could not prove.
    </p>
</template>
