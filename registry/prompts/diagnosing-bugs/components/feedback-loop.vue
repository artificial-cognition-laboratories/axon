<template>
    <section>
        <h2>Phase 1 — Build a feedback loop</h2>

        <p>
            <strong>This is the skill.</strong> Everything else is mechanical.
            If you have a tight pass/fail signal for the bug — one that goes
            red on <em>this</em> bug — you will find the cause; bisection,
            hypothesis-testing, and instrumentation all just consume it. If
            you don't have one, no amount of staring at code will save you.
        </p>

        <p>
            Spend disproportionate effort here. Be aggressive. Be creative.
            Refuse to give up.
        </p>

        <h3>Ways to construct one — try them in roughly this order</h3>

        <ol>
            <li><strong>Failing test</strong> at whatever seam reaches the bug — unit, integration, e2e.</li>
            <li><strong>HTTP script</strong> against a running dev server.</li>
            <li><strong>CLI invocation</strong> with a fixture input, diffing stdout against a known-good snapshot.</li>
            <li><strong>Headless browser script</strong> — drives the UI, asserts on DOM, console, and network.</li>
            <li><strong>Replay a captured trace.</strong> Save a real request, payload, or event log to disk; replay it through the code path in isolation.</li>
            <li><strong>Throwaway harness.</strong> Spin up a minimal subset of the system (one service, mocked deps) that exercises the bug path with a single function call.</li>
            <li><strong>Property or fuzz loop.</strong> If the bug is "sometimes wrong output", run a thousand random inputs and look for the failure mode.</li>
            <li><strong>Bisection harness.</strong> If the bug appeared between two known states, automate "boot at state X, check, repeat" so it can be bisected mechanically.</li>
            <li><strong>Differential loop.</strong> Run the same input through two versions or two configs and diff the outputs.</li>
            <li><strong>Human-in-the-loop script.</strong> Last resort. If a human must click, drive them with a script that prints one instruction at a time and reads their answers back, so the loop is still structured and its output still feeds back to you.</li>
        </ol>

        <p>Build the right feedback loop, and the bug is ninety percent fixed.</p>

        <h3>Tighten the loop</h3>

        <p>Treat the loop as a product. Once you have <em>a</em> loop, tighten it:</p>

        <ul>
            <li>Can I make it faster? Cache setup, skip unrelated init, narrow the test scope.</li>
            <li>Can I make the signal sharper? Assert on the specific symptom, not "didn't crash".</li>
            <li>Can I make it more deterministic? Pin time, seed the RNG, isolate the filesystem, freeze the network.</li>
        </ul>

        <p>
            A thirty-second flaky loop is barely better than no loop. A
            two-second deterministic one is a debugging superpower.
        </p>

        <h3>Non-deterministic bugs</h3>

        <p>
            The goal is not a clean repro but a <strong>higher reproduction
            rate</strong>. Loop the trigger a hundred times, parallelise, add
            stress, narrow timing windows, inject sleeps. A fifty-percent
            flake is debuggable; one percent is not — keep raising the rate
            until it is.
        </p>

        <h3>When you genuinely cannot build a loop</h3>

        <p>
            Stop and say so explicitly. List what you tried. Ask for one of:
            access to an environment that reproduces it, a captured artifact
            (HAR file, log dump, core dump, screen recording with timestamps),
            or permission to add temporary production instrumentation. Do
            <strong>not</strong> proceed to hypothesise without a loop.
        </p>

        <h3>Completion criterion — a tight loop that goes red</h3>

        <p>
            Phase 1 is done when you can name <strong>one command</strong> — a
            script path, a test invocation, an HTTP call — that you have
            already run at least once, quoting the invocation and its output,
            and that is:
        </p>

        <ul>
            <li><strong>Red-capable</strong> — it drives the actual bug code path and asserts the user's exact symptom, so it can go red on this bug and green once fixed. Not "runs without erroring" — it must be able to catch <em>this</em> bug.</li>
            <li><strong>Deterministic</strong> — same verdict every run, or a pinned high reproduction rate.</li>
            <li><strong>Fast</strong> — seconds, not minutes.</li>
            <li><strong>Runnable unattended</strong> — a human in the loop only via a driving script.</li>
        </ul>

        <p>
            If you catch yourself reading code to build a theory before this
            command exists, <strong>stop</strong> — jumping straight to a
            hypothesis is the exact failure this discipline prevents. No
            red-capable command, no Phase 2.
        </p>
    </section>
</template>
