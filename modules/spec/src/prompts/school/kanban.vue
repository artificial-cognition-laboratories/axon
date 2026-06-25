<template>
    <h2>Kanban</h2>

    <p>
        The kanban is the error signal. When an agent finds a violation of the spec,
        it files a proposal. Humans review proposals and move them to accepted. Agents
        action accepted items and move them to done.
    </p>

    <h3>Three states</h3>

    <ul>
        <li><code>proposal/</code> — filed by an agent or human, not yet reviewed</li>
        <li><code>accepted/</code> — approved by a human, ready to action</li>
        <li><code>done/</code> — completed, kept for record</li>
    </ul>

    <h3>Moving items</h3>

    <p>
        State transitions are file moves. No database, no tool needed — use the filesystem
        directly. Move a file from <code>proposal/</code> to <code>accepted/</code> to
        approve it. Move from <code>accepted/</code> to <code>done/</code> when complete.
    </p>

    <h3>When to file vs fix inline</h3>

    <ul>
        <li><strong>File a proposal</strong> — structural violations, wrong abstractions, missing invariant enforcement, architectural drift</li>
        <li><strong>Fix inline silently</strong> — naming, dead imports, trivial formatting, single-line corrections</li>
    </ul>

    <p>
        If the fix requires understanding intent or touching more than one file, file a proposal.
        The kanban exists so humans stay in the loop on structural decisions.
    </p>
</template>
