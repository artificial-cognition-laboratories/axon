<template>
    <h1>Triage Issue</h1>

    <p>
        Turn a reported issue into something actionable, or close it honestly.
        Triage is a decision about what happens next — not a summary of what
        was reported.
    </p>

    <h2>1. Understand what is actually claimed</h2>

    <p>Separate three things the report usually blends together:</p>

    <ul>
        <li><strong>What the reporter did</strong> — the steps, the input, the environment.</li>
        <li><strong>What happened</strong> — the observed behaviour, ideally quoted rather than characterised.</li>
        <li><strong>What they expected</strong> — which is often the real disagreement, and sometimes reveals the software is behaving correctly.</li>
    </ul>

    <p>
        If any of the three is missing and cannot be inferred, that is the
        outcome: say exactly what is needed. Be specific — "which version, and
        the full error text" gets an answer; "please provide more information"
        does not.
    </p>

    <h2>2. Try to reproduce</h2>

    <p>
        This is the step that determines everything downstream. Follow the
        stated steps exactly, on a supported version.
    </p>

    <ul>
        <li><strong>Reproduced</strong> — record the minimal path to it. That path is what makes the issue fixable by someone else.</li>
        <li><strong>Not reproduced</strong> — say precisely what you tried, on what version and environment. "Could not reproduce" alone is not a finding; the details are what let the reporter spot the difference.</li>
        <li><strong>Partially</strong> — say which part. A different symptom from the same steps is a real clue.</li>
    </ul>

    <h2>3. Classify it</h2>

    <ul>
        <li><strong>Bug</strong> — behaviour contradicts documented or reasonable expectation.</li>
        <li><strong>Enhancement</strong> — it works as designed; the design is the complaint.</li>
        <li><strong>Question or support</strong> — the software is fine, the usage was not. Answer it and say what was confusing, since that is often a documentation bug.</li>
        <li><strong>Duplicate</strong> — link the original; do not re-litigate it.</li>
        <li><strong>Not actionable</strong> — out of scope, unsupported version, or unreproducible after real effort. Say which, and why.</li>
    </ul>

    <p>
        Assess severity by consequence, not by tone. A calm report of silent
        data loss outranks an urgent one about a misaligned button.
    </p>

    <h2>4. Write the brief</h2>

    <p>Whoever picks this up should not have to redo your work. Give them:</p>

    <ul>
        <li>The problem in one sentence.</li>
        <li>The minimal reproduction, or the exact reason there isn't one.</li>
        <li>Where in the code it likely lives, if you found it.</li>
        <li>What "fixed" looks like — the observable change.</li>
        <li>What you ruled out, so nobody repeats it.</li>
    </ul>

    <h2>Rules</h2>

    <ul>
        <li><strong>Do not guess at a cause you have not traced.</strong> A confident wrong diagnosis in a brief sends the next person down a dead end.</li>
        <li><strong>Do not close something merely because it is hard to reproduce.</strong> Intermittent is a property of the bug, not evidence against it.</li>
        <li><strong>Mark the work as machine-generated</strong> where it is posted publicly, so a human knows to check it.</li>
        <li><strong>Do not fix it during triage.</strong> Triage decides what happens next; the fix is the next thing.</li>
    </ul>
</template>
