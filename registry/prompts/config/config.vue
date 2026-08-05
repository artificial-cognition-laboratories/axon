<template>
    <h1>Configuration</h1>

    <p>
        Handle configuration and secrets so that a misconfigured system fails
        immediately and obviously, rather than at 3am in the one environment
        nobody tested.
    </p>

    <h2>Validate at startup, not at use</h2>

    <p>
        Read and validate every configuration value when the process starts.
        A missing variable should stop the process with a message naming what
        is missing and where it comes from — not surface as a confusing null
        an hour later, in whichever code path happened to need it first.
    </p>

    <p>
        Parse into a typed shape once, at that boundary, and let the rest of
        the system consume the result. Code reaching directly into the
        environment mid-flow is unvalidated, untyped, and untestable.
    </p>

    <h2>Defaults are a decision</h2>

    <ul>
        <li><strong>Default to safe, not convenient.</strong> Where a setting affects security or data, absent should mean the restrictive option. A permission that defaults to open because nobody set it is how permissions get left open.</li>
        <li><strong>Never default a secret.</strong> A fallback credential is a credential that ships. Absent means fail.</li>
        <li><strong>Do not default something environment-specific.</strong> A production URL falling back to localhost fails in the worst possible way: silently, and looking like it works.</li>
    </ul>

    <h2>Secrets</h2>

    <ul>
        <li>Never in source, tests, fixtures, or committed config. Check before staging.</li>
        <li>Never in logs, error messages, or telemetry — redact at the point of emission, not downstream.</li>
        <li>Never sent to a third party as part of a payload or trace.</li>
        <li>Keep them out of the shape that gets serialised. A config object that is logged wholesale will eventually be logged wholesale.</li>
    </ul>

    <h2>Across environments</h2>

    <p>
        Environments should differ by <em>values</em>, not by code paths.
        Branching on the environment name scatters behaviour that only ever
        runs in one place, which means it is only ever tested in one place.
    </p>

    <p>
        Where behaviour genuinely must differ, express it as a named setting —
        a flag saying what it does — rather than a check for which environment
        this is. The former is testable and self-describing; the latter is
        neither.
    </p>

    <p>
        <strong>A development bypass guarded by an environment check is an
        auth hole waiting for a misconfiguration.</strong> Treat those with the
        same suspicion as hardcoded credentials.
    </p>

    <h2>Make it discoverable</h2>

    <p>
        Every setting should be documented in one place with its purpose,
        whether it is required, and its safe default. A committed example file
        listing every variable with dummy values is the cheapest version of
        this and prevents the most common failure: someone deploying without
        knowing a variable existed.
    </p>
</template>
