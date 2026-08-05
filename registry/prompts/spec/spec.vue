<template>
    <h1>Spec</h1>

    <p>
        Turn what has already been discussed into a written specification.
        <strong>Do not interview</strong> — this is synthesis of an existing
        conversation and codebase understanding, not a fresh requirements
        session.
    </p>

    <h2>Before writing</h2>

    <p>
        Understand the current state of the code well enough that the spec
        describes a real change to a real system. Use the project's own domain
        vocabulary throughout, and respect any recorded decisions in the area
        being touched.
    </p>

    <p>
        Then sketch the seams at which this will be tested. Prefer existing
        seams to new ones, and place any new seam as high as possible — the
        fewer seams a change introduces, the better, and one is the ideal
        number. Confirm those seams with the user before writing the spec
        proper; getting them wrong invalidates the testing section entirely.
    </p>

    <h2>The document</h2>

    <ul>
        <li><strong>Problem</strong> — what the user is facing, from their point of view. Not the technical symptom.</li>
        <li><strong>Solution</strong> — what changes for them, still from their point of view.</li>
        <li><strong>User stories</strong> — a long, numbered list in the form "as an actor, I want a feature, so that a benefit". Be exhaustive; this is where scope gets pinned down, and a story nobody wrote is a story nobody built.</li>
        <li><strong>Implementation decisions</strong> — the modules built or modified, the interfaces changed, schema changes, contracts, and any technical clarification already settled.</li>
        <li><strong>Testing decisions</strong> — which modules are tested, at which seams, and what prior art in this codebase the tests should resemble.</li>
        <li><strong>Out of scope</strong> — what this deliberately does not cover.</li>
        <li><strong>Open questions</strong> — what remains genuinely unresolved.</li>
    </ul>

    <h2>Rules</h2>

    <ul>
        <li>
            <strong>No file paths or code snippets</strong> in implementation
            decisions. They go stale faster than anything else in the document
            and are the first thing that makes a spec untrustworthy. Describe
            modules and interfaces, not lines.
            <br>
            The one exception: a snippet that encodes a decision more precisely
            than prose can — a state machine, a schema, a type shape. Trim it
            to the decision, not a working example.
        </li>
        <li>
            <strong>Do not invent requirements.</strong> If something was not
            discussed and you cannot infer it confidently, it goes in open
            questions. A spec that quietly fills gaps produces work nobody
            asked for.
        </li>
        <li>
            <strong>Write what is observable.</strong> Requirements that cannot
            be verified cannot be built to. "Fast" is not a requirement; a
            number is.
        </li>
        <li>
            <strong>Separate what is decided from what is assumed.</strong> A
            reader must be able to tell which is which.
        </li>
    </ul>
</template>
