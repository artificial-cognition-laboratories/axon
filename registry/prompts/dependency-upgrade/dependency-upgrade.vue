<template>
    <h1>Dependency Upgrade</h1>

    <p>
        Move dependencies forward without breaking the project. The work is
        reading changelogs and verifying behaviour — the version bump itself is
        the trivial part.
    </p>

    <h2>1. Establish what is out of date and why it matters</h2>

    <p>
        List what is outdated, and separate it into three groups, because they
        justify very different amounts of risk:
    </p>

    <ul>
        <li><strong>Security</strong> — a known vulnerability in something you actually reach. Do these first.</li>
        <li><strong>Blocking</strong> — an upgrade something else needs, or a version nearing end of support.</li>
        <li><strong>Housekeeping</strong> — everything else. Worth doing, but not worth a broken week.</li>
    </ul>

    <p>
        A vulnerability in a dependency you do not exercise is lower priority
        than the advisory suggests. Check whether the affected path is reachable
        before treating it as urgent.
    </p>

    <h2>2. Read before upgrading</h2>

    <p>
        For each package, read the changelog between the current and target
        version — every intervening major, not just the newest. Note breaking
        changes, deprecations, and any migration guide the maintainers wrote.
    </p>

    <p>
        A major version with no changelog is itself a finding: it means the
        upgrade has to be verified entirely by testing, and that should change
        how much appetite there is for it.
    </p>

    <h2>3. Upgrade in separable steps</h2>

    <ul>
        <li><strong>One package, or one coherent group, at a time.</strong> Bumping thirty at once means a failure tells you nothing about its cause.</li>
        <li><strong>Patch and minor together is usually fine.</strong> Majors get their own step, always.</li>
        <li><strong>Keep related packages in lockstep</strong> — a framework and its plugins move together or not at all.</li>
        <li><strong>Run the full suite after each step</strong>, and keep each step separately revertible.</li>
    </ul>

    <h2>4. Verify beyond the type checker</h2>

    <p>
        A clean typecheck and a green suite are necessary, not sufficient.
        Breaking changes routinely land as behaviour changes that types cannot
        see: different defaults, altered error handling, changed ordering,
        stricter parsing.
    </p>

    <p>
        Exercise the paths that actually use the upgraded package. Where the
        changelog names a behaviour change, go and confirm what the code now
        does at that call site.
    </p>

    <h2>Rules</h2>

    <ul>
        <li><strong>Do not suppress a new error to make the build pass.</strong> A cast or an ignore added during an upgrade is a bug being committed deliberately.</li>
        <li><strong>Do not refactor while upgrading.</strong> Migration changes and improvements in one diff cannot be reviewed or reverted separately.</li>
        <li><strong>Stop and report if an upgrade needs real work.</strong> A major that demands a migration across forty files is a decision for the user, not something to absorb quietly.</li>
        <li><strong>Report what you could not verify.</strong> Say which upgrades are exercised by tests and which are only typechecked.</li>
    </ul>
</template>
