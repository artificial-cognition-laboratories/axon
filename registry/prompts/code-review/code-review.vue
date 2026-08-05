<template>
    <h1>Code Review</h1>

    <p>
        Review the diff between <code>HEAD</code> and a fixed point along two
        independent axes:
    </p>

    <ul>
        <li><strong>Standards</strong> — does the code conform to how this repo says code should be written?</li>
        <li><strong>Spec</strong> — does the code faithfully implement what was actually asked for?</li>
    </ul>

    <h2>1. Pin the fixed point</h2>

    <p>
        The fixed point is whatever the user named — a commit SHA, a branch, a
        tag, <code>main</code>, <code>HEAD~5</code>. If they didn't name one,
        ask. Do not guess.
    </p>

    <p>
        Resolve it and capture the diff once. Compare against the merge-base,
        not the branch tip, so you review what this branch changed rather than
        what it is merely behind on:
    </p>

    <pre>{{ diffCommands }}</pre>

    <p>
        Confirm the ref resolves and the diff is non-empty before going
        further. A bad ref or an empty diff should fail here, loudly, rather
        than halfway through a review that had nothing to look at.
    </p>

    <h2>2. Find the spec</h2>

    <p>Look for what originated this work, in this order:</p>

    <ol>
        <li>Issue references in the commit messages — <code>#123</code>, <code>Closes #45</code>. Fetch them if you have access.</li>
        <li>A path the user gave you.</li>
        <li>A spec, PRD, or design note under <code>docs/</code> or similar, matching the branch name or feature.</li>
        <li>If nothing turns up, ask. If the user says there is no spec, skip the Spec axis and say so in the report — do not invent a spec and review against it.</li>
    </ol>

    <h2>3. Find the standards</h2>

    <p>
        Anything in the repo documenting how code should be written:
        <code>CLAUDE.md</code>, <code>AGENTS.md</code>,
        <code>CONTRIBUTING.md</code>, a coding-standards doc, a package-level
        convention file. Read them before reviewing, and cite them by name
        when you find a breach.
    </p>

    <SmellBaseline />

    <h2>4. Review each axis separately</h2>

    <p>
        Work the two axes independently and do not let findings from one bleed
        into the other. If the runtime can run them as separate agents, do
        that — the isolation is the point, not an optimisation.
    </p>

    <h3>Standards axis</h3>

    <p>Report, per file or hunk where it helps:</p>

    <ul>
        <li>Every place the diff violates a documented standard. Cite the standard — the file, and the rule.</li>
        <li>Every baseline smell you spot. Name it and quote the hunk.</li>
    </ul>

    <p>
        Distinguish hard violations from judgement calls. A documented
        standard can be breached hard; a baseline smell is always a judgement
        call, and a documented repo standard overrides the baseline. Skip
        anything the tooling already enforces — nobody needs a linter
        impersonation.
    </p>

    <h3>Spec axis</h3>

    <p>Report:</p>

    <ul>
        <li>Requirements the spec asked for that are missing or only partly done.</li>
        <li>Behaviour in the diff that nobody asked for — scope creep.</li>
        <li>Requirements that look implemented but where the implementation looks wrong.</li>
    </ul>

    <p>Quote the spec line for every finding.</p>

    <h2>5. Report</h2>

    <p>
        Present the two under <code>## Standards</code> and
        <code>## Spec</code> headings. <strong>Do not merge or re-rank across
        them.</strong>
    </p>

    <p>
        End with one line: the number of findings per axis, and the worst
        issue <em>within each axis</em>. Do not pick a single overall winner —
        that is exactly the re-ranking the separation exists to prevent.
    </p>

    <h2>Why two axes</h2>

    <p>A change can pass one and fail the other:</p>

    <ul>
        <li>Code that follows every standard but implements the wrong thing — Standards pass, Spec fail.</li>
        <li>Code that does exactly what was asked but breaks the project's conventions — Spec pass, Standards fail.</li>
    </ul>

    <p>
        Reported together, the healthy axis masks the broken one. Reported
        apart, both stay visible.
    </p>
</template>

<script setup lang="ts">
const diffCommands = `git diff <fixed-point>...HEAD
git log <fixed-point>..HEAD --oneline`
</script>
