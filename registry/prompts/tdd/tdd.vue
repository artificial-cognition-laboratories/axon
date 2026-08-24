<template>
    <h1>Test-Driven Development</h1>

    <p>
        Build the requested change test-first, using the loop below.
    </p>

    <p>
        TDD is the red → green loop. What follows is what makes that loop
        produce tests worth keeping: what a good test is, where tests go, the
        anti-patterns, and the rules. Every section applies on every cycle —
        consult them before and during the loop, not after.
    </p>

    <h2>The loop</h2>

    <ol>
        <li>Agree the seam (see below). Write one failing test against it.</li>
        <li>Run it. Confirm it fails, and fails for the reason you expect.</li>
        <li>Write the minimum code that makes it pass. Nothing more.</li>
        <li>Run it. Confirm green.</li>
        <li>Return to step 1 with what this cycle taught you.</li>
    </ol>

    <h2>What a good test is</h2>

    <p>
        Tests verify behaviour through public interfaces, not implementation
        details. Code can change entirely; tests shouldn't. A good test reads
        like a specification — "user can checkout with valid cart" tells you
        exactly what capability exists — and survives refactors because it
        doesn't care about internal structure.
    </p>

    <pre>{{ goodTest }}</pre>

    <p>
        That test uses only the public API, describes what rather than how,
        makes one logical assertion, and would survive the checkout internals
        being rewritten from scratch.
    </p>

    <h2>Seams — where tests go</h2>

    <p>
        A <strong>seam</strong> is the public boundary you test at: the
        interface where you observe behaviour without reaching inside. Tests
        live at seams, never against internals.
    </p>

    <p>
        <strong>Test only at pre-agreed seams.</strong> Before writing any
        test, state the seams under test and confirm them with the user. No
        test is written at an unconfirmed seam. You can't test everything —
        agreeing the seams up front is how testing effort lands on critical
        paths and complex logic instead of every edge case.
    </p>

    <p>Ask: "What's the public interface, and which seams should we test?"</p>

    <h2>Mocking</h2>

    <p>Mock at system boundaries only:</p>

    <ul>
        <li>External APIs — payment, email, third-party HTTP</li>
        <li>Databases — though a real test database is usually better</li>
        <li>Time and randomness</li>
        <li>The file system — sometimes</li>
    </ul>

    <p>Do not mock your own classes, internal collaborators, or anything you control.</p>

    <p>
        At the boundaries you do mock, design for it: pass external
        dependencies in rather than constructing them internally. A function
        that takes a <code>paymentClient</code> is trivial to test; one that
        builds its own is not.
    </p>

    <h2>Anti-patterns</h2>

    <ul>
        <li>
            <strong>Implementation-coupled</strong> — mocks internal
            collaborators, tests private methods, or verifies through a side
            channel (querying the database instead of using the interface).
            The tell: the test breaks when you refactor but behaviour hasn't
            changed.
        </li>
        <li>
            <strong>Tautological</strong> — the assertion recomputes the
            expected value the way the code does
            (<code>expect(add(a, b)).toBe(a + b)</code>, a snapshot derived by
            hand the same way, a constant asserted equal to itself), so it
            passes by construction and can never disagree with the code.
            Expected values must come from an independent source of truth: a
            known-good literal, a worked example, the spec.
        </li>
        <li>
            <strong>Horizontal slicing</strong> — writing all tests first,
            then all implementation. Bulk tests verify <em>imagined</em>
            behaviour: you test the shape of things rather than user-facing
            behaviour, the tests go insensitive to real changes, and you
            commit to test structure before understanding the implementation.
            Work in <strong>vertical slices</strong> instead — one test, one
            implementation, repeat.
        </li>
    </ul>

    <h2>Rules</h2>

    <ul>
        <li>
            <strong>Red before green.</strong> Write the failing test first,
            then only enough code to pass it. Don't anticipate future tests or
            add speculative features.
        </li>
        <li>
            <strong>One slice at a time.</strong> One seam, one test, one
            minimal implementation per cycle.
        </li>
        <li>
            <strong>A test that has never failed is not a test.</strong> If
            you didn't watch it go red, you don't know it's wired up.
        </li>
        <li>
            <strong>Refactoring is not part of the loop.</strong> It belongs
            to review, not the red → green cycle.
        </li>
        <li>
            <strong>Never weaken a test to make it pass.</strong> If a test is
            failing, the code is wrong until proven otherwise. Deleting the
            assertion, loosening the matcher, or adding a conditional skip is
            not a green build.
        </li>
    </ul>

    <p>
        Match the project's existing test conventions — framework, file
        location, and naming. Read a neighbouring test file before writing the
        first one. If the project documents its domain language, make test
        names and interface vocabulary agree with it.
    </p>
</template>

<script setup lang="ts">
const goodTest = `test("user can checkout with valid cart", async () => {
    const cart = createCart()
    cart.add(product)

    const result = await checkout(cart, paymentMethod)

    expect(result.status).toBe("confirmed")
})`
</script>
