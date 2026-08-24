<template>
    <h1>Estimate</h1>

    <p>
        Break work into pieces and say how long it will take — with the
        uncertainty stated, not hidden. A single confident number is almost
        always wrong and always trusted more than it deserves.
    </p>

    <h2>Decompose first</h2>

    <p>
        Estimating a whole feature produces a guess. Estimating its parts
        produces an estimate, because most of the error lives in work nobody
        listed rather than in mis-sized work that was.
    </p>

    <p>
        Break down until each piece is something you could describe how to
        build. Anything you cannot describe is not an estimate — it is a
        research task, and should be named as one.
    </p>

    <h2>Count the work that is always forgotten</h2>

    <p>
        The implementation is usually the smaller half. Explicitly account for:
    </p>

    <ul>
        <li>Tests, and making existing tests pass again.</li>
        <li>Review, and the round trips after it.</li>
        <li>Migration and backfill, where data is involved.</li>
        <li>Error paths, edge cases, and the states nobody demonstrated.</li>
        <li>Documentation, configuration, and deployment.</li>
        <li>Reading unfamiliar code before changing it.</li>
    </ul>

    <h2>State uncertainty honestly</h2>

    <p>
        Give a range, not a point, and make the range reflect real confidence.
        A piece you have built before might be one to two days; one depending
        on an unfamiliar external API might be one to five, and saying so is
        the useful part.
    </p>

    <p>
        Name what drives the spread. "Three days if the existing parser handles
        this, two weeks if it needs replacing — I can find out in an hour" is
        far more actionable than any number, because it identifies the cheap
        question that collapses the uncertainty.
    </p>

    <h2>Separate estimate from commitment</h2>

    <p>
        An estimate is what you believe. A deadline is a decision someone
        makes. Do not adjust the first to fit the second — when an estimate
        exceeds available time, the honest response is to name what could be
        cut, not to shrink the number.
    </p>

    <h2>Rules</h2>

    <ul>
        <li><strong>Never give a number without decomposition.</strong> Say what it is made of.</li>
        <li><strong>Estimate the work, not the wish.</strong> Optimism does not accelerate anything; it only moves the discovery of the truth later.</li>
        <li><strong>Flag unknowns as unknowns.</strong> "I don't know until I look at X" is a legitimate and often correct answer.</li>
        <li><strong>Say what would make it faster.</strong> Cut scope, relaxed constraints, a decision made earlier — these are usually more valuable than the estimate.</li>
    </ul>
</template>
