<template>
    <h1>Code Comprehension</h1>

    <p>
        Understand a specific piece of code well enough to explain it, change
        it, or judge it. The failure mode is producing a fluent summary of
        something you have only pattern-matched — which reads exactly like
        understanding and is not.
    </p>

    <h2>Read the code, not the names</h2>

    <p>
        Function and variable names are claims, not facts. A function called
        <code>validateUser</code> may also write to the database, and a
        comment above it may describe behaviour that was removed a year ago.
        Verify what things do by reading what they do.
    </p>

    <h2>Follow the data</h2>

    <p>
        The fastest route to understanding is usually a value, not a call
        graph. Pick the important piece of data and trace it: where it comes
        from, everything that transforms it, where it ends up. Control flow is
        much easier to understand once you know what is flowing through it.
    </p>

    <p>
        Then establish the boundaries — what this code calls out to, and what
        calls into it. Code makes far more sense once you know its obligations
        to callers.
    </p>

    <h2>Find out why it is like this</h2>

    <p>
        Code that looks wrong is often load-bearing. Before concluding
        something is bad, check whether it exists for a reason you cannot see:
    </p>

    <ul>
        <li>The commit that introduced it, and its message.</li>
        <li>The tests, which state what it is meant to do.</li>
        <li>Comments explaining a workaround or an external constraint.</li>
        <li>Whether an odd-looking branch handles a real case that occurred.</li>
    </ul>

    <p>
        This is what separates a useful reading from a naive one. Almost every
        strange piece of code was a reasonable response to something — the
        question is whether that something is still true.
    </p>

    <h2>Test your understanding</h2>

    <p>
        Understanding is only confirmed by prediction. Pick an input and
        predict the output before running it. Predict what breaks if a line is
        deleted. Where you can, run it and check.
    </p>

    <p>
        Being wrong here is the point — it is precisely where a comfortable
        wrong model gets caught, before it has been built on.
    </p>

    <h2>Explain it honestly</h2>

    <p>Report in this order:</p>

    <ol>
        <li>What it does, in one or two sentences.</li>
        <li>How it does it — the mechanism, at a level that would let someone change it.</li>
        <li>The non-obvious parts: constraints, edge cases, and why odd things are the way they are.</li>
        <li><strong>What you are not sure about</strong>, specifically.</li>
    </ol>

    <p>
        That last part is mandatory. Mark clearly where you inferred rather
        than verified — a confident explanation of code you half-followed is
        worse than no explanation, because everyone downstream now believes it.
    </p>
</template>
