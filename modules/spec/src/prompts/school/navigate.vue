<template>
    <h2>Navigating the Spec</h2>

    <p>
        The spec tree is designed for efficient traversal. Never load the whole tree —
        load the minimum needed to answer the question.
    </p>

    <h3>Load order</h3>

    <ol>
        <li>Start at <code>.agents/spec/docs/index.md</code> — the monorepo map</li>
        <li>Follow the <strong>Map</strong> section to the relevant boundary</li>
        <li>Load that boundary's <code>index.md</code> — check invariants, follow Map if going deeper</li>
        <li>Stop as soon as you have what you need</li>
    </ol>

    <h3>Finding invariants</h3>

    <p>
        Invariants live in the <code>## Invariants</code> section of each
        <code>index.md</code>. Load the boundary's <code>index.md</code> first.
        If the invariant isn't there, check child system folders. Invariants are
        never in any file other than <code>index.md</code>.
    </p>

    <h3>Finding patterns</h3>

    <p>
        Load <code>.agents/spec/patterns/</code> files for universal conventions.
        Then check <code>.agents/spec/docs/{boundary}/patterns/</code> for
        boundary-specific overrides. Local patterns win on conflict.
    </p>

    <h3>What not to do</h3>

    <ul>
        <li>Do not load entire subtrees speculatively</li>
        <li>Do not infer spec content from the codebase — the spec is the source of truth</li>
        <li>Do not update <code>index.md</code> with implementation detail you found in the code</li>
    </ul>
</template>
