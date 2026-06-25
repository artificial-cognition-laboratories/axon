<template>
    <h2>Invariants</h2>

    <p>
        Invariants are hard correctness requirements. They are not guidelines — a violation
        is a bug. They live in the <code>## Invariants</code> section of each
        <code>index.md</code> and are identified by a prefixed ID.
    </p>

    <h3>ID scheme</h3>

    <p>
        IDs are scoped to their boundary using the path from <code>docs/</code>:
    </p>

    <ul>
        <li><code>backend:I1</code> — top-level boundary invariant</li>
        <li><code>backend/auth:I3</code> — system-level invariant</li>
        <li><code>backend/auth/device-flow:I1</code> — module-level invariant</li>
    </ul>

    <h3>Format</h3>

    <p>Each invariant is one line — the ID, a colon, the rule. No prose around it.</p>

    <pre>## Invariants

I1: Auth tokens must never appear in logs, events, or error messages
I2: Every endpoint requires auth unless explicitly marked public
I3: Cognos internals are never exposed in any response or error</pre>

    <h3>Referencing invariants</h3>

    <p>
        When filing a kanban proposal, always reference the invariant being violated
        using its full scoped ID. This is the link between the error signal and the
        source of truth.
    </p>
</template>
