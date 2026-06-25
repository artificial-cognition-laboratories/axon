<template>
    <h2>Index Format</h2>

    <p>
        Every folder in <code>docs/</code> has an <code>index.md</code>. This is the only
        file an agent needs to load to understand a boundary. It has four locked sections,
        always in this order, always present even if empty.
    </p>

    <h3>Frontmatter</h3>

    <pre>---
type: process | package | pipeline | cross-cutting
path: docs/backend
owns: apps/backend
---</pre>

    <p>
        <code>owns</code> maps the boundary to its actual location in the codebase.
        This is how scouts know where to look.
    </p>

    <h3>Locked sections</h3>

    <ul>
        <li><strong>Map</strong> — one-liner per child folder. The tree in prose form.</li>
        <li><strong>Purpose</strong> — why this boundary exists. Three sentences max. No implementation detail.</li>
        <li><strong>Invariants</strong> — hard correctness requirements. Prefixed <code>I1:</code>, <code>I2:</code> etc.</li>
        <li><strong>Relationships</strong> — what it depends on, what depends on it, what it exposes.</li>
    </ul>

    <h3>What does not belong in index.md</h3>

    <ul>
        <li>Route-by-route API documentation</li>
        <li>Implementation detail or current behaviour</li>
        <li>Live state or metrics</li>
        <li>Anything that changes faster than the design changes</li>
    </ul>

    <p>
        If content doesn't fit the four sections, it either belongs in a child folder's
        <code>index.md</code> or it doesn't belong in the spec at all.
    </p>
</template>
