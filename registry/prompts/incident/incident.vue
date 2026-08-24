<template>
    <h1>Incident</h1>

    <p>
        Respond to something broken in production. This is a different
        discipline from debugging, and confusing the two makes incidents
        longer: <strong>the goal is to stop the damage, not to understand
        it.</strong> Diagnosis comes after.
    </p>

    <h2>1. Establish impact</h2>

    <p>Before touching anything, answer:</p>

    <ul>
        <li>What is broken, observably, from a user's point of view?</li>
        <li>How many are affected — everyone, one region, one customer?</li>
        <li>Is it getting worse, stable, or recovering?</li>
        <li>Is data being lost or corrupted right now?</li>
    </ul>

    <p>
        That last one changes everything. Ongoing data damage justifies
        aggressive action — taking a service down is better than corrupting
        another hour of records. Degraded-but-correct does not.
    </p>

    <h2>2. Stabilise before diagnosing</h2>

    <p>
        Reach for the fastest safe route back to working, in this order:
    </p>

    <ol>
        <li><strong>Roll back</strong> the recent change, if one correlates. Fastest, most reliable, and does not require understanding.</li>
        <li><strong>Disable</strong> the failing path — a flag, a route, a queue consumer — if the rest can run without it.</li>
        <li><strong>Scale or restart</strong>, if it is resource exhaustion. Buys time; does not fix causes.</li>
        <li><strong>Fix forward</strong> only when rollback is impossible. This is the slowest option and the one most likely to make things worse under pressure.</li>
    </ol>

    <p>
        <strong>Do not investigate root cause while the fire burns.</strong>
        The temptation to understand first is strong and it is wrong. Restore
        service, then investigate with the pressure off.
    </p>

    <h2>3. Preserve the evidence</h2>

    <p>
        Before restarting or rolling back, capture what will be destroyed:
        logs, metrics at the failure window, stack traces, queue depths, a
        snapshot of the bad state. A restart that fixes the symptom and erases
        the evidence guarantees a second incident.
    </p>

    <h2>4. Communicate while you work</h2>

    <p>
        Say what is broken, who is affected, what is being done, and when the
        next update comes. Update on that cadence even when there is no news —
        silence during an incident is read as nothing happening.
    </p>

    <p>
        Never state a cause you have not confirmed. An early wrong theory
        travels further than the correction.
    </p>

    <h2>5. Afterwards</h2>

    <p>
        Once stable, investigate properly. Then ask what would have prevented
        it, and what would have made it shorter — detection, alerting,
        rollback speed, and the runbook are all fair targets.
    </p>

    <p>
        Write it up without blame. Incidents are caused by systems that permit
        mistakes, and a write-up that identifies a person produces a team that
        stops reporting problems early.
    </p>

    <h2>Under pressure</h2>

    <ul>
        <li><strong>Narrate what you are doing</strong> as you do it, so anyone joining can catch up and so a wrong step can be caught.</li>
        <li><strong>Change one thing at a time.</strong> Three simultaneous fixes and nobody knows what worked or what made it worse.</li>
        <li><strong>Do not run destructive commands from memory.</strong> Read them back before executing.</li>
        <li><strong>Say when you are out of ideas.</strong> Escalating early is cheap; a long silent flail is not.</li>
    </ul>
</template>
