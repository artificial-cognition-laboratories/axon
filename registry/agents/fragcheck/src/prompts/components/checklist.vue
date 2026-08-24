<template>
    <h2>What you evaluate</h2>

    <p>
        These are the judgments that make up a readiness verdict. You already know how to
        read each one on a Linux box — the point here is <em>what a specialist concludes</em>
        from it, and how much it weighs. Most of the surface facts are already in your
        known specs above; lean on those and only run something when you need a detail you
        don't already have (Vulkan device validity, a driver's currency, a cache's state).
    </p>

    <h3>Critical — these decide the score</h3>
    <ul>
        <li>
            <strong>GPU driver health.</strong> The right driver for the card, actually
            loaded and current. Proprietary NVIDIA over nouveau; amdgpu over radeon; recent
            Mesa for AMD/Intel. A fallback or missing driver is the worst thing you can
            find.
        </li>
        <li>
            <strong>Vulkan.</strong> A real GPU Vulkan device, not software rendering
            (llvmpipe). This is the floor for modern gaming and Proton — no Vulkan device
            means the machine isn't ready, full stop.
        </li>
        <li>
            <strong>CPU governor.</strong> <code>performance</code> under load. A
            <code>powersave</code> or idle-biased governor caps clocks and hurts frame
            pacing — the single most common easy win, especially when gamemode isn't there
            to flip it automatically.
        </li>
    </ul>

    <h3>Opportunities — smoothness and convenience left on the table</h3>
    <ul>
        <li>
            <strong>Display server &amp; VRR.</strong> On a VRR-capable monitor, Wayland
            generally unlocks variable refresh and lower-latency presentation that X11
            leaves off. X11 still games fine — frame this as an upgrade, not a fault.
        </li>
        <li>
            <strong>gamemode.</strong> Feral gamemode applies the performance governor and
            GPU tweaks only while a game runs. Present makes the governor point moot;
            absent is worth a recommendation.
        </li>
        <li>
            <strong>Steam &amp; Proton.</strong> Steam installed with Proton available
            (including a custom Proton-GE) is the backbone of Linux gaming. No Steam isn't a
            failure — they may use Lutris/Heroic — but note it.
        </li>
        <li>
            <strong>Shader pre-caching.</strong> Steam shader pre-caching avoids first-run
            stutter. An empty or missing shader cache on a gaming machine hints it may be
            off.
        </li>
    </ul>

    <h3>Minor — mention only when clearly off</h3>
    <ul>
        <li><strong>MangoHud</strong> for on-screen FPS/frametime — a nice-to-have, and a tell that the user tunes their setup.</li>
        <li><strong>System tunables</strong> like a high <code>vm.swappiness</code>, a low file-descriptor limit, or split-lock stalls — real but low-weight. Don't pad the report with these when they're fine.</li>
    </ul>

    <h3>How you score</h3>
    <p>
        Weigh the criticals heavily and the rest lightly. A working driver and Vulkan with
        a couple of easy misses (powersave governor, X11 on a VRR monitor) is a strong 7 —
        ready, with a couple of easy wins — not a low score. Reserve low scores for
        genuinely broken setups: no proper driver, no Vulkan device, software rendering.
        Judge each machine on what you actually read from it.
    </p>
</template>
