<template>
    <h1>Diagnosing Bugs</h1>

    <p>
        A discipline for hard bugs and performance regressions. Work the
        phases in order. Skip one only when you can say out loud why it does
        not apply.
    </p>

    <p>
        The single failure this prevents: reading code to build a theory
        before you have a way to test it. Everything below exists to stop
        that.
    </p>

    <FeedbackLoop />

    <section>
        <h2>Phase 2 — Reproduce and minimise</h2>

        <p>Run the loop. Watch it go red — the bug appears.</p>

        <p>Confirm all three before continuing:</p>

        <ul>
            <li>The loop produces the failure the <strong>user</strong> described — not a different failure that happens to live nearby. Wrong bug, wrong fix.</li>
            <li>The failure reproduces across multiple runs, or at a high enough rate to debug against.</li>
            <li>You have captured the exact symptom — error message, wrong output, slow timing — so later phases can verify the fix addresses it.</li>
        </ul>

        <h3>Minimise</h3>

        <p>
            Once it is red, shrink the repro to the smallest scenario that
            still goes red. Cut inputs, callers, config, data, and steps
            <strong>one at a time</strong>, re-running the loop after each
            cut. Keep only what is load-bearing.
        </p>

        <p>
            This is worth the effort twice over: a minimal repro shrinks the
            hypothesis space in Phase 3, and becomes the clean regression test
            in Phase 5.
        </p>

        <p>
            Done when every remaining element is load-bearing — removing any
            one of them makes the loop go green.
        </p>
    </section>

    <section>
        <h2>Phase 3 — Hypothesise</h2>

        <p>
            Generate <strong>three to five ranked hypotheses</strong> before
            testing any of them. Generating one at a time anchors you on the
            first plausible idea.
        </p>

        <p>
            Each hypothesis must be falsifiable — state the prediction it
            makes:
        </p>

        <blockquote>
            If X is the cause, then changing Y will make the bug disappear, or
            changing Z will make it worse.
        </blockquote>

        <p>
            If you cannot state the prediction, the hypothesis is a vibe.
            Discard it or sharpen it.
        </p>

        <p>
            <strong>Show the ranked list to the user before testing.</strong>
            They often re-rank it instantly with knowledge you don't have —
            "we just deployed a change to number three" — or know which ones
            they have already ruled out. Cheap checkpoint, large saving. Don't
            block on it; proceed with your own ranking if they are away.
        </p>
    </section>

    <section>
        <h2>Phase 4 — Instrument</h2>

        <p>
            Every probe must map to a specific prediction from Phase 3. Change
            one variable at a time.
        </p>

        <ol>
            <li><strong>Debugger or REPL inspection</strong> where the environment supports it. One breakpoint beats ten logs.</li>
            <li><strong>Targeted logs</strong> at the boundaries that distinguish one hypothesis from another.</li>
            <li>Never "log everything and grep".</li>
        </ol>

        <p>
            <strong>Tag every debug log</strong> with a unique prefix, for
            example <code>[DEBUG-a4f2]</code>. Cleanup then becomes a single
            search. Untagged logs survive forever; tagged logs die.
        </p>

        <p>
            <strong>For performance work, logs are usually the wrong tool.</strong>
            Establish a baseline measurement first — a timing harness, a
            profiler, a query plan — then bisect against it. Measure first,
            fix second.
        </p>
    </section>

    <section>
        <h2>Phase 5 — Fix and regression test</h2>

        <p>
            Write the regression test <strong>before</strong> the fix — but
            only if there is a correct seam for it.
        </p>

        <p>
            A correct seam exercises the real bug pattern as it occurs at the
            call site. If the only available seam is too shallow — a
            single-caller test when the bug needs several, a unit test that
            cannot replicate the chain that triggered it — a regression test
            there gives false confidence.
        </p>

        <p>
            <strong>If no correct seam exists, that is itself the finding.</strong>
            Say so. The architecture is preventing the bug from being locked
            down, which is worth more to the user than a test that passes
            without meaning anything.
        </p>

        <p>Where a correct seam does exist:</p>

        <ol>
            <li>Turn the minimised repro into a failing test at that seam.</li>
            <li>Watch it fail.</li>
            <li>Apply the fix.</li>
            <li>Watch it pass.</li>
            <li>Re-run the Phase 1 loop against the original, un-minimised scenario.</li>
        </ol>
    </section>

    <section>
        <h2>Phase 6 — Cleanup and post-mortem</h2>

        <p>Required before declaring the bug done:</p>

        <ul>
            <li>The original repro no longer reproduces — re-run the Phase 1 loop to prove it.</li>
            <li>The regression test passes, or the absence of a seam is written down.</li>
            <li>All tagged instrumentation is removed — search for the prefix.</li>
            <li>Throwaway harnesses are deleted, or moved somewhere clearly marked.</li>
            <li>The hypothesis that turned out correct is stated in the commit or PR message, so the next person to touch this learns something.</li>
        </ul>

        <p>
            <strong>Then ask: what would have prevented this bug?</strong> If
            the answer is architectural — no good test seam, tangled callers,
            hidden coupling — say so with specifics. Make that recommendation
            <em>after</em> the fix is in, not before: you know far more now
            than you did at the start.
        </p>
    </section>
</template>
