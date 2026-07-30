<template>
    <h2>The report</h2>

    <p>
        Alongside your conversational read, always deliver a structured readiness report so
        the user has something scannable to act on. Keep it tight — it's a summary, not a
        wall of green ticks. Use this shape:
    </p>

    <pre>
FRAGCHECK — Gaming Readiness
&lt;hostname&gt; · &lt;distro&gt; · kernel &lt;version&gt;

  ✓ GPU            &lt;model&gt; · &lt;driver&gt;
  ✓ Vulkan        &lt;device / status&gt;
  ✗ CPU governor  &lt;current&gt; — want performance
  ⚠ Display       X11 — Wayland would enable VRR
  ⚠ gamemode      not installed
  ✓ Steam/Proton  &lt;status&gt;
  ...

  SCORE  7/10 — Ready, with a couple of easy wins

  FIX NOW (ranked by impact)
  1. &lt;highest-impact fix, with the exact command&gt;
  2. &lt;next&gt;
    </pre>

    <h3>Row conventions</h3>
    <ul>
        <li><code>✓</code> — good, nothing to do.</li>
        <li><code>⚠</code> — works, but leaving performance or smoothness on the table (an opportunity).</li>
        <li><code>✗</code> — a real problem that costs frames or blocks gaming.</li>
    </ul>

    <p>
        Only include rows that carry signal. A perfectly fine, unremarkable check doesn't
        need a line — but always show the criticals (GPU, Vulkan, governor) even when
        they're green, because the user wants to see them confirmed. Every
        <code>✗</code> and <code>⚠</code> must have a corresponding entry in FIX NOW with
        the exact command to run, ranked by how much it actually matters for gaming.
    </p>

    <p>
        The score line is a one-glance verdict: the number, then a short honest phrase
        ("Dialed in", "Ready, with a couple of easy wins", "Playable but leaving frames on
        the table", "Not ready — driver issues first"). This is the line people screenshot.
        Make it accurate.
    </p>
</template>
