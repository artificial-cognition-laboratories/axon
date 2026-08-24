<template>
    <h1>Observability</h1>

    <p>
        Make the system explain itself when it misbehaves. The test of
        observability is not whether it emits data — it is whether someone
        woken at 3am can find out what is wrong without attaching a debugger.
    </p>

    <h2>Instrument the questions, not the code</h2>

    <p>
        Start from what you would need to know when this breaks, and work
        backwards. "Which user, which request, which downstream call, and how
        long did it take" is a question. "Log the function entry" is not.
    </p>

    <p>Every significant operation should be able to answer:</p>

    <ul>
        <li>Did it happen, and did it succeed?</li>
        <li>How long did it take?</li>
        <li>Who or what triggered it, and can I follow that identifier across services?</li>
        <li>If it failed, why — with enough context to act, not just a type name.</li>
    </ul>

    <h2>What good looks like</h2>

    <ul>
        <li>
            <strong>Structured, not interpolated.</strong> Emit fields, not
            sentences. A message with the identifier embedded in prose cannot
            be filtered or aggregated; the same data as fields can.
        </li>
        <li>
            <strong>Correlated.</strong> A request identifier that flows
            through every log, span, and downstream call. Without it,
            distributed logs are unreadable at volume.
        </li>
        <li>
            <strong>Levelled honestly.</strong> Error means someone must act.
            Warn means it is degraded but handled. Info is the operational
            narrative. Debug is for development. An error log for a handled
            condition trains everyone to ignore errors.
        </li>
        <li>
            <strong>Contextual on failure.</strong> The inputs, the state, and
            what was being attempted — enough to reconstruct the failure
            without reproducing it.
        </li>
    </ul>

    <h2>What to avoid</h2>

    <ul>
        <li><strong>Secrets and personal data in telemetry.</strong> Tokens, credentials, request bodies, and personal identifiers get shipped to third parties and retained. Redact at the emitting site.</li>
        <li><strong>Logging in hot loops.</strong> Volume that costs more than it explains, and drowns the useful signal.</li>
        <li><strong>Silent paths.</strong> A caught exception that emits nothing is a bug you will never see. Every swallowed error is a hole in the picture.</li>
        <li><strong>Metrics nobody reads.</strong> If no dashboard or alert consumes it, it is cost without value.</li>
    </ul>

    <h2>Untraced critical paths are bugs</h2>

    <p>
        Treat a significant operation that emits nothing as a defect in its own
        right, not a missing nice-to-have. Undebuggable code is code that will
        eventually cost far more than the instrumentation would have.
    </p>

    <p>
        When reviewing or adding instrumentation, name the paths that are
        currently invisible and what a failure there would look like from the
        outside. Usually the answer is "a timeout with no explanation", which
        is the case for fixing it.
    </p>
</template>
