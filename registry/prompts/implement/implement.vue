<template>
    <h1>Implement</h1>

    <p>
        Build the work described in the spec, tickets, or request you have
        been given. This is the disciplined version of "just write the code" —
        the parts that keep a long implementation from drifting.
    </p>

    <h2>Before writing anything</h2>

    <p>
        Restate what you are building in two or three sentences, and list the
        acceptance criteria as you understand them. If the spec is ambiguous
        on something that changes the implementation, ask now — not after
        you've built the wrong branch of it.
    </p>

    <p>
        Read the surrounding code first. Match its conventions, its naming,
        and its existing abstractions. Code that is locally idiomatic is worth
        more than code that is globally clever.
    </p>

    <h2>Work in vertical slices</h2>

    <p>
        One slice at a time, each one a complete thin path through the system
        rather than a horizontal layer. Test-first where there is a seam worth
        testing, at seams agreed with the user before you write the test.
    </p>

    <p>
        Do not build the whole data layer, then the whole service layer, then
        the whole UI. Build one working path end to end, then the next. Each
        slice teaches you something the next one uses.
    </p>

    <h2>Keep the feedback tight</h2>

    <ul>
        <li>Typecheck regularly — not once at the end.</li>
        <li>Run the single relevant test file as you go.</li>
        <li>Run the full suite once, at the end, before you call it done.</li>
    </ul>

    <p>
        A long stretch of writing code without running anything is how an hour
        of work becomes an hour of debugging.
    </p>

    <h2>Scope discipline</h2>

    <p>
        Build what was asked. When you spot something else that wants fixing,
        note it and mention it — do not fold it in silently. An
        implementation that also quietly refactored three neighbouring
        modules is not reviewable.
    </p>

    <p>
        If you find the spec is wrong or impossible partway through, stop and
        say so with what you found. Do not implement something adjacent and
        hope it passes.
    </p>

    <h2>Before declaring done</h2>

    <ul>
        <li>Every acceptance criterion is met, or the gap is stated explicitly.</li>
        <li>The full test suite passes — say so, with the output, and never describe failing tests as passing.</li>
        <li>Typechecking is clean.</li>
        <li>Debug logging and scratch files are removed.</li>
        <li>The work is reviewed before it is called finished.</li>
    </ul>

    <p>
        Report honestly. If something is incomplete, blocked, or skipped, say
        which and why. A truthful "three of four done, the fourth is blocked
        on X" is worth far more than a confident "done" that isn't.
    </p>
</template>
