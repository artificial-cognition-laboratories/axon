<template>
    <h1>Handoff</h1>

    <p>
        Compact this conversation into a document a fresh agent can pick the
        work up from, with no access to anything said here.
    </p>

    <p>
        Write it to a temporary location, not into the workspace. A handoff is
        scaffolding for the next session, not an artifact of the project, and
        committing it leaves a directory of stale summaries nobody trusts.
    </p>

    <h2>What goes in</h2>

    <ul>
        <li><strong>The goal</strong> — what is being built or fixed, and why. One paragraph.</li>
        <li><strong>State</strong> — what is done, what is in progress, what has not been started.</li>
        <li><strong>Decisions made</strong> — what was chosen, and the reasoning. Especially where an obvious-looking alternative was rejected, because the next agent will otherwise propose it again.</li>
        <li><strong>What was tried and failed</strong> — dead ends, with the reason each one died. This is the highest-value section: it is the part that cannot be recovered from the repo, and the part that otherwise gets rediscovered the expensive way.</li>
        <li><strong>Open questions</strong> — what is unresolved, and who or what can resolve it.</li>
        <li><strong>Next step</strong> — the single thing to do first, stated concretely.</li>
    </ul>

    <h2>What stays out</h2>

    <p>
        <strong>Do not duplicate what already exists elsewhere.</strong> Specs,
        plans, decision records, issues, commits, diffs — reference them by
        path or URL. A handoff that restates a spec goes stale the moment the
        spec changes, and now two documents disagree.
    </p>

    <p>
        <strong>Do not narrate the conversation.</strong> The next agent does
        not need to know what was discussed in what order. It needs the current
        state and the reasoning behind it.
    </p>

    <p>
        <strong>Redact anything sensitive</strong> — keys, tokens, passwords,
        personal data. Handoff documents get pasted around freely, which is
        exactly what makes them a leak risk.
    </p>

    <h2>Be honest about state</h2>

    <p>
        Describe what is actually true, not what was intended. If something is
        half-finished, say which half. If tests are failing, say which and why.
        If you are unsure whether something works, say that rather than
        implying it does.
    </p>

    <p>
        An over-confident handoff is worse than no handoff: the next agent
        builds on a foundation it was told is solid, and finds out otherwise
        several steps later.
    </p>

    <h2>Close with what to load</h2>

    <p>
        End with the context the next agent should pull in before starting —
        the files worth reading first, and any prompt or reference that applies
        to the work ahead.
    </p>
</template>
