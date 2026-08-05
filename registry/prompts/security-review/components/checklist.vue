<template>
    <section>
        <h2>What to look for</h2>

        <p>
            Work these against the diff. Each is a question about the change,
            not a general audit of the codebase.
        </p>

        <h3>Input and output</h3>

        <ul>
            <li><strong>Injection</strong> — user-controlled data reaching a SQL query, shell command, file path, template, or eval. Look for string concatenation where a parameterised call belongs.</li>
            <li><strong>Path traversal</strong> — user input used to build a filesystem path without normalising and confining it to an intended root.</li>
            <li><strong>Output encoding</strong> — untrusted data rendered into HTML, JSON, logs, or a terminal without escaping for that context.</li>
            <li><strong>Deserialisation</strong> — untrusted input parsed into objects that can carry executable behaviour.</li>
        </ul>

        <h3>Identity and access</h3>

        <ul>
            <li><strong>Missing authorisation</strong> — a new endpoint, route, or handler with no permission check, or one that checks authentication and forgets authorisation.</li>
            <li><strong>Object-level access</strong> — an identifier taken from the request and used to fetch a record without confirming the caller may see <em>that</em> record.</li>
            <li><strong>Privilege boundaries</strong> — a check performed somewhere the caller controls, or after the sensitive work has already happened.</li>
            <li><strong>Token handling</strong> — credentials logged, cached, forwarded to a third party, or held longer than the operation needs.</li>
        </ul>

        <h3>Secrets and data</h3>

        <ul>
            <li><strong>Hardcoded credentials</strong> — keys, tokens, passwords, or connection strings in source, tests, fixtures, or config.</li>
            <li><strong>Leakage through errors</strong> — stack traces, SQL, internal paths, or identifiers returned to a caller who should not see them.</li>
            <li><strong>Sensitive data in logs</strong> — personal data, tokens, or full request bodies written to a log that is shipped elsewhere.</li>
            <li><strong>Transport</strong> — sensitive data crossing a boundary without TLS, or certificate verification disabled.</li>
        </ul>

        <h3>Cryptography and randomness</h3>

        <ul>
            <li><strong>Home-rolled crypto</strong>, or a primitive used for something it was not built for.</li>
            <li><strong>Weak randomness</strong> where unpredictability matters — tokens, session identifiers, password resets, nonces.</li>
            <li><strong>Password storage</strong> using a fast hash rather than a slow, salted one.</li>
            <li><strong>Comparison of secrets</strong> with a short-circuiting equality check rather than a constant-time one.</li>
        </ul>

        <h3>Dependencies and configuration</h3>

        <ul>
            <li><strong>New dependencies</strong> — what they are, who maintains them, and whether the capability justifies the added surface.</li>
            <li><strong>Permissive defaults</strong> — CORS, cookie flags, security headers, file permissions, or a bucket policy loosened by the change.</li>
            <li><strong>Debug affordances</strong> — verbose errors, test endpoints, or bypasses that are on outside development.</li>
        </ul>
    </section>
</template>
