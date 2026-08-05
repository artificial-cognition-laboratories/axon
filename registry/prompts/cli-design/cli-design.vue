<template>
    <h1>CLI Design</h1>

    <p>
        Design a command-line interface for two audiences at once: a human
        typing it, and a script consuming it. Most bad CLIs serve the first and
        forget the second.
    </p>

    <h2>Shape</h2>

    <ul>
        <li><strong>Verb the noun</strong> — <code>tool deploy agent</code>. Consistent ordering lets people guess commands they have not used.</li>
        <li><strong>Required things are arguments; optional things are flags.</strong> If it is mandatory, do not make it a named option.</li>
        <li><strong>Long names, with short aliases for the common ones.</strong> Scripts read better with long names; typing wants short ones.</li>
        <li><strong>Follow platform conventions.</strong> Whatever a user already expects — the standard help and version flags, the standard way of ending option parsing — is not a place to be original.</li>
        <li><strong>Match your own siblings.</strong> A subcommand that names its options differently from the others is a bug in the interface.</li>
    </ul>

    <h2>Output</h2>

    <p>
        <strong>Results to standard output; everything else to standard
        error.</strong> This is the rule that makes a tool composable. Progress,
        warnings, and diagnostics on the error stream mean the output stream
        stays pipeable.
    </p>

    <ul>
        <li>Offer machine-readable output where anything might be consumed programmatically — and keep its shape stable, since it is now an API.</li>
        <li>Detect whether output is a terminal. Colour, spinners, and tables are for humans; a pipe gets plain text.</li>
        <li>Default to the useful amount of detail, with a flag for more and a flag for silence.</li>
        <li>Say what happened. A command that succeeds silently leaves the user unsure whether it ran.</li>
    </ul>

    <h2>Exit codes</h2>

    <p>
        Zero for success, non-zero for failure — always, without exception.
        Scripts branch on this, and a tool that exits zero having failed breaks
        every pipeline it is in. Distinguish failure classes with different
        non-zero codes where callers might reasonably want to tell them apart.
    </p>

    <h2>Errors</h2>

    <p>
        Say what went wrong, why, and what to do. "Invalid argument" is not an
        error message; naming the argument, what was expected, and what was
        received is. Where a mistake is common — a typo'd subcommand, a missing
        required flag — suggest the correction.
    </p>

    <h2>Destructive operations</h2>

    <ul>
        <li>Confirm before anything irreversible, and say specifically what will happen.</li>
        <li>Provide a flag to skip confirmation, because scripts cannot answer prompts — but never make skipping the default.</li>
        <li>Detect non-interactive use and fail with a clear message rather than hanging on a prompt nobody can see.</li>
        <li>Offer a dry run for anything with wide effects.</li>
    </ul>

    <h2>Discoverability</h2>

    <p>
        Help output should show usage, the options with real descriptions, and
        a worked example or two. Examples are the most-read part of any help
        text and the most often missing. Help must work without configuration,
        credentials, or network — a tool that cannot explain itself until it is
        set up is hostile at exactly the moment someone needs it.
    </p>
</template>
