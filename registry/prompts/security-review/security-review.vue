<template>
    <h1>Security Review</h1>

    <p>
        Review the change for security defects. This is a review of a diff, not
        a penetration test and not an audit of the whole system — the question
        is whether <em>this change</em> introduces or exposes a weakness.
    </p>

    <h2>Establish the change and its exposure</h2>

    <p>
        Read the diff against the merge-base. Then, before judging anything,
        establish the two facts that determine whether a finding matters:
    </p>

    <ul>
        <li><strong>What is the trust boundary?</strong> Which of this data is attacker-controlled, and where does it cross from untrusted to trusted?</li>
        <li><strong>What is reachable?</strong> A weakness in an unreachable path is a different severity from the same weakness on a public endpoint.</li>
    </ul>

    <Checklist />

    <h2>Reporting</h2>

    <p>For each finding, give:</p>

    <ul>
        <li><strong>The defect</strong> — one sentence, at a specific file and line.</li>
        <li><strong>The path to it</strong> — how untrusted input reaches the weakness. A finding without a reachable path is a hardening suggestion; label it as one.</li>
        <li><strong>The impact</strong> — what an attacker gets. "Reads any user's records", not "security risk".</li>
        <li><strong>The fix</strong> — concretely, in this codebase's idiom.</li>
    </ul>

    <p>Order by exploitability first, then impact. Separate confirmed defects from things that merit a look.</p>

    <h2>Rules</h2>

    <ul>
        <li>
            <strong>Do not pad the report.</strong> A list of theoretical
            issues buries the real one. If the change is clean, say it is
            clean.
        </li>
        <li>
            <strong>Do not report what tooling already catches.</strong> If a
            linter or scanner is wired into this repo, its findings are not
            yours.
        </li>
        <li>
            <strong>Trace before claiming.</strong> Follow the input path far
            enough to know it is real. "This looks like it might be
            injectable" is not a finding.
        </li>
        <li>
            <strong>Do not write exploits.</strong> Describe the path
            precisely enough to fix and to test; stop there.
        </li>
        <li>
            <strong>Say what you did not cover.</strong> Areas you could not
            reach, or assumptions you had to make about callers, belong in the
            report.
        </li>
    </ul>
</template>
