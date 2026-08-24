<template>
    <h1>Domain Modeling</h1>

    <p>
        Actively build and sharpen the project's domain model as you design.
        This is the <em>active</em> discipline: challenging terms, inventing
        edge-case scenarios, and writing the glossary and the decisions down
        the moment they crystallise.
    </p>

    <p>
        Reading a glossary for vocabulary is not this — that is a habit any
        piece of work can have. This is for when the model is being
        <strong>changed</strong>, not merely consumed.
    </p>

    <h2>Where things live</h2>

    <p>
        A glossary at the repo root, and one file per architectural decision
        under a decisions directory. Where a repo holds several genuinely
        distinct domains, a map at the root names each one and points at its
        own glossary.
    </p>

    <p>
        <strong>Create files lazily</strong> — only when there is something to
        write. No glossary until the first term is resolved; no decisions
        directory until the first decision needs recording. An empty template
        committed early is a file everyone learns to ignore.
    </p>

    <h2>During the session</h2>

    <h3>Challenge against the glossary</h3>

    <p>
        When a term conflicts with the language already recorded, say so
        immediately: "the glossary defines cancellation as X, but you seem to
        mean Y — which is it?" A drifting term is how two people have the same
        conversation twice and reach different conclusions.
    </p>

    <h3>Sharpen fuzzy language</h3>

    <p>
        When a term is vague or overloaded, propose a precise canonical one.
        "You said account — do you mean the Customer or the User? Those are
        different things." Do not let an ambiguous word survive the
        conversation that revealed it.
    </p>

    <h3>Stress-test with concrete scenarios</h3>

    <p>
        When relationships are under discussion, invent specific scenarios that
        probe the edges and force precision about where one concept stops and
        the next begins. Abstract agreement is cheap; a scenario is what
        exposes that two people meant different things.
    </p>

    <h3>Cross-reference against the code</h3>

    <p>
        When someone states how something works, check whether the code agrees.
        Surface every contradiction you find: "the code cancels whole orders,
        but you just said partial cancellation is possible — which is right?"
        This is the highest-value move here, because the answer is always
        interesting: either the model is wrong or the code is.
    </p>

    <h3>Write it down as it resolves</h3>

    <p>
        When a term is settled, record it immediately. Do not batch them up —
        capture each one as it happens, while the reasoning is still live.
    </p>

    <p>
        The glossary holds <strong>no implementation details</strong>. It is
        not a spec, not a scratchpad, and not somewhere design decisions go. It
        is a glossary, and it stays one.
    </p>

    <h2>Record decisions sparingly</h2>

    <p>Only propose recording a decision when all three are true:</p>

    <ol>
        <li><strong>Hard to reverse</strong> — changing your mind later carries meaningful cost.</li>
        <li><strong>Surprising without context</strong> — a future reader will ask "why on earth did they do it this way?"</li>
        <li><strong>The result of a real trade-off</strong> — there were genuine alternatives, and one was chosen for statable reasons.</li>
    </ol>

    <p>
        If any of the three is missing, skip it. A directory full of decisions
        that were never really decisions is worse than an empty one: it trains
        everyone to skim.
    </p>

    <Formats />
</template>
