<template>
    <h1>Research</h1>

    <p>
        Investigate the question against primary sources and write the
        findings down as a durable document. The output is a file, not a chat
        message — research nobody can re-read is research done twice.
    </p>

    <p>
        If the runtime can run this in the background, do that: reading is
        slow, and the caller should keep working while it happens.
    </p>

    <h2>Primary sources only</h2>

    <p>
        Go to the thing that owns the fact — official documentation, the
        source code itself, the specification, the first-party API — not a
        blog post describing it. Secondary write-ups are stale, partial, or
        subtly wrong often enough that a claim traced only to one is not yet
        a finding.
    </p>

    <p>
        Follow every claim back to the source that owns it. Where a secondary
        source is the only thing available, say so explicitly and mark the
        claim as unverified.
    </p>

    <h2>Rules</h2>

    <ul>
        <li><strong>Cite every claim.</strong> A finding without a source is an opinion. Link or path, next to the claim, not gathered in a heap at the end.</li>
        <li><strong>Quote the load-bearing parts.</strong> When a claim turns on exact wording — a version constraint, a guarantee, a limit — quote it rather than paraphrasing.</li>
        <li><strong>Record what you could not find.</strong> An unanswered sub-question is a finding. Silence reads as "no problem here", which is a lie if you simply didn't look.</li>
        <li><strong>Note version and date.</strong> Docs move. Say which version you read and when, so a reader knows when to distrust it.</li>
        <li><strong>Do not fill gaps from memory.</strong> If the sources don't answer it, that is the answer. Never present recalled knowledge as something you verified.</li>
        <li><strong>Contradictions are results.</strong> Where two primary sources disagree, report both and say which you trust and why. Do not quietly pick one.</li>
    </ul>

    <h2>The document</h2>

    <p>
        Write to a single markdown file. Put it where the repo already keeps
        notes of this kind, matching the existing convention. If there is no
        convention, choose somewhere sensible and say clearly where you put
        it.
    </p>

    <p>Structure it so it survives being read cold, months later:</p>

    <ul>
        <li>The question, as asked.</li>
        <li>A short answer up front — the finding, not a summary of your process.</li>
        <li>The detail, with citations.</li>
        <li>What remains open or unverified.</li>
        <li>The date, and the versions of anything you read.</li>
    </ul>

    <p>
        Lead with the answer. A reader who stops after the first paragraph
        should already have the useful part.
    </p>
</template>
