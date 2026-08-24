<template>
    <h1>Database Migration</h1>

    <p>
        Change a schema without losing data or taking the system down. This is
        among the least reversible things in software: treat every step as
        production, because eventually it is.
    </p>

    <h2>The rule that governs everything else</h2>

    <p>
        <strong>Old code and new schema must coexist.</strong> During any
        deploy there is a window where both versions run against one database.
        A migration that only works if code and schema change simultaneously
        will fail in that window.
    </p>

    <p>
        Which means destructive changes are split across releases — expand,
        migrate, contract:
    </p>

    <ol>
        <li><strong>Expand</strong> — add the new column, table, or index. Nullable or defaulted. Old code ignores it.</li>
        <li><strong>Migrate</strong> — backfill, and have the new code write to both shapes while reading the new one.</li>
        <li><strong>Contract</strong> — once nothing reads the old shape, and not before, remove it.</li>
    </ol>

    <p>
        Renaming a column is the same three steps, never one. A rename is a
        drop and an add wearing a disguise.
    </p>

    <h2>Writing the migration</h2>

    <ul>
        <li><strong>Always write the rollback</strong>, and test it. A migration you cannot reverse is one you cannot deploy on a Friday — and the one you will need to reverse.</li>
        <li><strong>Make it idempotent where the tooling allows.</strong> Migrations get re-run after partial failures.</li>
        <li><strong>Backfill in batches</strong>, outside the schema change. A single statement updating ten million rows takes a lock and holds it.</li>
        <li><strong>Know which operations lock.</strong> Adding a non-null column with a default, adding an index non-concurrently, or changing a type can lock a table for the duration. On a large table that is an outage.</li>
        <li><strong>Add indexes concurrently</strong> where the database supports it.</li>
        <li><strong>Never edit a migration that has run anywhere.</strong> Write a new one. Editing history means environments silently diverge.</li>
    </ul>

    <h2>Before running it anywhere real</h2>

    <ul>
        <li>Run it against a realistic copy — realistic in <em>size</em>, not just shape. Locking behaviour only appears at volume.</li>
        <li>Time it, and know what is locked while it runs.</li>
        <li>Run the rollback, then run the migration again.</li>
        <li>Confirm a backup exists and that restoring it has actually been tried.</li>
        <li>Check the constraints hold against real data — production always contains rows that violate the invariant you assumed.</li>
    </ul>

    <h2>Report</h2>

    <p>
        State what changes, which steps are destructive, what locks and for how
        long, how to roll back, and what the deploy ordering has to be. If the
        migration must run before or after the code deploy, say so explicitly —
        that ordering is where these go wrong.
    </p>
</template>
