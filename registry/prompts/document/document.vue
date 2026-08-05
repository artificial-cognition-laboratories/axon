<template>
    <h1>Document</h1>

    <p>
        Write documentation someone reaches for and actually gets an answer
        from. Most documentation fails not because it is wrong but because it
        answers a question nobody asked.
    </p>

    <h2>Decide which kind this is</h2>

    <p>
        Four kinds, with different readers and different rules. Mixing them is
        the most common failure — a tutorial interrupted by API detail serves
        neither reader.
    </p>

    <ul>
        <li><strong>Tutorial</strong> — teaches a beginner by doing. Ordered steps that work if followed exactly. Optimise for the reader succeeding, not for completeness; leave things out.</li>
        <li><strong>How-to</strong> — solves one specific problem for someone who knows roughly what they are doing. Starts at the problem, ends when it is solved.</li>
        <li><strong>Reference</strong> — describes what exists, exhaustively and neutrally. Structured for lookup, not for reading through.</li>
        <li><strong>Explanation</strong> — why it works this way, what was traded, what the alternatives were. The only kind where opinion belongs.</li>
    </ul>

    <h2>Write from the reader's question</h2>

    <p>
        Name the reader and what they arrived wanting to know, then answer
        exactly that. Lead with the answer — someone who stops after the first
        paragraph should already have the useful part.
    </p>

    <p>
        Prefer a working example over description. A short, correct, runnable
        example teaches faster than three paragraphs about it, and can be
        verified.
    </p>

    <h2>Rules</h2>

    <ul>
        <li><strong>Verify every example.</strong> Run the code, follow the steps yourself. A broken example is worse than none: it costs the reader trust in everything around it.</li>
        <li><strong>Do not document what the code says.</strong> A comment restating the signature adds a thing to keep in sync and no information. Document the why, the constraint, the surprise.</li>
        <li><strong>Do not write documentation that will rot.</strong> Anything duplicating a fast-moving detail will be wrong within a month. Point at the source of truth instead.</li>
        <li><strong>Say when something is unfinished or unsupported.</strong> Honest gaps are more useful than confident silence.</li>
        <li><strong>Match the existing voice and structure.</strong> Documentation that reads as a different project is jarring even when it is better.</li>
    </ul>

    <h2>Comments in code</h2>

    <p>
        The same rule, smaller. Explain the non-obvious: why this approach, why
        the obvious one fails, what invariant is being upheld, what breaks if
        this changes. Never narrate what the next line plainly does.
    </p>

    <p>
        A comment explaining <em>why</em> survives refactoring. A comment
        explaining <em>what</em> becomes a lie the first time someone edits the
        line beneath it.
    </p>
</template>
