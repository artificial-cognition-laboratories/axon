<template>
    <h2>Spec Tree</h2>

    <p>
        The <code>.agents/spec/</code> folder is the source of truth for this repository.
        It is not generated — it is maintained by humans and agents together. Every file
        in it is slow-moving: purpose, invariants, conventions. Never live state, never
        implementation detail.
    </p>

    <ul>
        <li><code>docs/</code> — boundary specs. One folder per deployable, package, or pipeline.</li>
        <li><code>patterns/</code> — cross-cutting conventions that apply across all boundaries.</li>
        <li><code>policy/</code> — org-level rules: ownership, security, release.</li>
        <li>
            <code>kanban/</code> — work items. Proposals, accepted work, completed work.
            <ul>
                <li><code>proposal/</code> — filed but not yet reviewed</li>
                <li><code>accepted/</code> — approved, ready to action</li>
                <li><code>done/</code> — completed</li>
            </ul>
        </li>
    </ul>

    <p>
        <code>docs/</code> is the code-level spec. Everything else sits above the code.
        <code>kanban/</code> is the error signal — violations of what <code>docs/</code>
        and <code>patterns/</code> define.
    </p>
</template>
