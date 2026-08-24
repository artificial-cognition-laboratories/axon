<template>
    <h1>Error Handling</h1>

    <p>
        Decide what can fail, what happens when it does, and who finds out.
        Most error handling is written reflexively — a try block wrapped around
        whatever threw last time — and that reflex is what produces systems
        that fail silently and are impossible to debug.
    </p>

    <h2>The rule</h2>

    <p>
        <strong>Never silently swallow an error.</strong> A catch block that
        logs and continues, a fallback value that masks a broken assumption, a
        default that hides a null which should never have been null — each of
        these converts a loud, findable failure into a quiet, permanent one.
    </p>

    <p>
        A system that crashes on invalid state is trustworthy: it tells you
        exactly where reality diverged from expectation. A system that degrades
        silently is a landmine, and the explosion happens far from the cause.
    </p>

    <h2>Where to handle</h2>

    <p>
        <strong>Validate ruthlessly at boundaries; trust the interior.</strong>
        Everything crossing into the system from outside — network responses,
        user input, file contents, environment, subprocess output — is
        untrusted and gets checked at the seam where it arrives.
    </p>

    <p>
        Past that seam, code should be able to assume its inputs are valid,
        because the type says so. Defensive checks scattered through the
        interior are a symptom of a boundary that isn't doing its job, and they
        make every function harder to read for a case that cannot happen.
    </p>

    <p>
        <strong>Catch where you can act.</strong> If the current function can
        genuinely do something about a failure — retry, fall back to a real
        alternative, add context — catch it. If it cannot, let it propagate.
        Catching to log and rethrow is duplication; catching to log and
        continue is a bug.
    </p>

    <h2>What an error should carry</h2>

    <ul>
        <li><strong>A structured code</strong>, not just a message. Callers should branch on identity, never on string matching.</li>
        <li><strong>Context</strong> — the operation attempted and the relevant inputs, so the failure can be understood without reproducing it.</li>
        <li><strong>The cause</strong> — the underlying error, preserved rather than replaced. A rethrown error that discards its cause destroys the stack trace that would have located the problem.</li>
        <li><strong>An actionable message</strong> — what went wrong and, where possible, what to do. Aimed at whoever reads it: a user, or an engineer at 3am.</li>
    </ul>

    <h2>Failure modes to check for</h2>

    <ul>
        <li><strong>Empty catch blocks</strong>, or catches whose body is only a log call.</li>
        <li><strong>Fire-and-forget async</strong> — a promise never awaited and never handled, so its rejection vanishes.</li>
        <li><strong>Fallbacks masking bugs</strong> — a default substituted for a value whose absence means something is actually broken.</li>
        <li><strong>Catch-all at the wrong level</strong> — a handler so broad it swallows unrelated failures, including programming errors.</li>
        <li><strong>Errors as control flow</strong> — throwing for an ordinary expected outcome, so real failures become indistinguishable from routine ones.</li>
        <li><strong>Losing errors in loops</strong> — iterating with individual failures caught and dropped, so a run that failed entirely reports success.</li>
    </ul>

    <h2>Temporary bypasses</h2>

    <p>
        A workaround that skips validation or returns early to dodge an error
        gets a comment saying it is temporary, why it exists, and when it goes.
        Otherwise it is permanent, and nobody will know it was ever meant to
        be otherwise — which is how a development convenience becomes a
        production hole.
    </p>
</template>
