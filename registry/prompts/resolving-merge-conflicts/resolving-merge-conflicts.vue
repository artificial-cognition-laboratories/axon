<template>
    <h1>Resolving Merge Conflicts</h1>

    <p>
        Resolve an in-progress merge or rebase. The work is understanding two
        intents well enough to preserve both — the textual conflict is the easy
        part.
    </p>

    <h2>1. See the current state</h2>

    <p>
        Establish what is actually happening before touching a file: whether
        this is a merge or a rebase, which commits are involved on each side,
        and which files conflict. A rebase resolves one commit at a time and
        will present further conflicts after each continue; a merge resolves
        once.
    </p>

    <h2>2. Find the primary sources for each side</h2>

    <p>
        For every conflicting hunk, understand <em>why</em> each change was
        made and what it was for. Read the commit messages on both sides, and
        follow them to the pull request, issue, or ticket that motivated them.
    </p>

    <p>
        This is the step that gets skipped, and skipping it is what produces a
        resolution that compiles, passes, and quietly discards a fix somebody
        shipped last week. A conflict is two intentions meeting; you cannot
        reconcile intentions you have not read.
    </p>

    <h2>3. Resolve each hunk</h2>

    <ul>
        <li><strong>Preserve both intents wherever possible.</strong> Most conflicts are two changes to neighbouring lines, not two answers to one question.</li>
        <li><strong>Where they are genuinely incompatible</strong>, pick the one matching the stated goal of this merge, and say plainly what was given up.</li>
        <li><strong>Do not invent new behaviour.</strong> A conflict is not an opportunity to redesign. If neither side is right, resolve faithfully first and raise the problem separately.</li>
        <li><strong>Always resolve.</strong> Never abort as a way out of a hard hunk.</li>
    </ul>

    <p>
        Watch for conflicts that are semantic rather than textual: two sides
        that merge cleanly but disagree about behaviour. A renamed function on
        one side and a new caller on the other will not conflict, and will not
        work.
    </p>

    <h2>4. Run the project's checks</h2>

    <p>
        Discover what this project runs — typically typecheck, then tests, then
        format — and run them. Fix whatever the merge broke.
    </p>

    <p>
        A clean merge that fails the suite is not resolved. If a test fails,
        establish which side's behaviour it was asserting before changing
        anything: a failing test after a merge is usually correct and telling
        you the resolution dropped something.
    </p>

    <h2>5. Finish</h2>

    <p>
        Stage the resolutions and complete the merge or rebase. For a rebase,
        continue until every commit has been replayed — expect further
        conflicts on the way and work each one the same way.
    </p>

    <p>
        Report what you resolved and, specifically, every place where you had
        to choose one side over the other. Those are the decisions someone else
        needs to know you made on their behalf.
    </p>
</template>
