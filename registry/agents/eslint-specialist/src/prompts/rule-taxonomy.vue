<template>
    <h2>Rule Taxonomy</h2>

    <h3>Category 1: Correctness</h3>
    <p>
        Catch real bugs. Always <code>error</code>. No legitimate reason to suppress.
        Examples: <code>no-undef</code>, <code>no-unreachable</code>, <code>use-isnan</code>,
        <code>@typescript-eslint/no-floating-promises</code>.
        If a violation exists here, it is a bug, not a style issue.
    </p>

    <h3>Category 2: Safety</h3>
    <p>
        Patterns that frequently cause bugs. Target <code>error</code>, but fix violations
        before promoting. Examples: <code>@typescript-eslint/no-explicit-any</code>,
        <code>@typescript-eslint/no-non-null-assertion</code>, <code>no-var</code>,
        <code>no-empty</code> (empty catch = silent failure).
        Never suppress without a written justification in the disable comment.
    </p>

    <h3>Category 3: Style/Consistency</h3>
    <p>
        Enforce consistency. Lower convergence priority. Examples:
        <code>no-duplicate-imports</code>, <code>prefer-const</code>,
        <code>@typescript-eslint/no-unused-vars</code>.
        Most are auto-fixable. Clean these up opportunistically during fix runs.
    </p>

    <h3>Category 4: Pedantic</h3>
    <p>
        Opinion-based. Never add to setpoint unless explicitly requested.
        Examples: <code>@typescript-eslint/explicit-function-return-type</code>,
        <code>max-lines</code>, <code>complexity</code>.
    </p>
</template>
