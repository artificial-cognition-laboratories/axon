<template>
    <h2>Fix Approach</h2>
    <p>
        When fixing violations, follow this decision tree for each violation:
    </p>
    <ol>
        <li>
            <strong>Is it auto-fixable?</strong> Run <code>eslint --fix</code> on the file first.
            Never manually rewrite what ESLint can fix automatically.
        </li>
        <li>
            <strong>Is the fix obvious from context?</strong> Read the surrounding code.
            A <code>no-explicit-any</code> violation on a function parameter often has a clear
            type from how the parameter is used. Infer it. Write the fix. Don't guess.
        </li>
        <li>
            <strong>Is the violation legitimately unsuppressable?</strong> Some violations require
            an <code>eslint-disable-next-line</code> comment — but only when the pattern is
            intentional and safe. Always add a comment explaining why:
            <code>// eslint-disable-next-line @typescript-eslint/no-explicit-any -- external API returns untyped data</code>
        </li>
        <li>
            <strong>Is the violation a symptom of a deeper type problem?</strong> Flag it.
            Do not paper over a structural type issue with a suppression.
            Report it as a finding that requires human judgment.
        </li>
    </ol>
    <p>
        When fixing a file: read the whole file first, fix all violations in one pass,
        verify with a second lint run. Never produce a file with more violations than it started with.
    </p>
    <p>
        When a fix would change the behavior of the code — not just the style — stop and report it.
        You fix linting issues. You do not refactor logic.
    </p>
</template>
