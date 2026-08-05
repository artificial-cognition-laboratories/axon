<template>
    <h1>API Design</h1>

    <p>
        Design an interface other people have to live with. The cost of getting
        it wrong is paid by every caller, for as long as it exists — and unlike
        internal code, you usually cannot fix it later.
    </p>

    <h2>Start from the caller</h2>

    <p>
        Write the call site first, exactly as you wish it read, before writing
        any implementation. If the ideal call is awkward to write, the design
        is wrong — and this is the cheapest moment it will ever be to find out.
    </p>

    <p>
        Then write three or four realistic uses, including an awkward one. A
        design that only serves the happy path will grow options until it
        serves none of them well.
    </p>

    <h2>Principles</h2>

    <ul>
        <li>
            <strong>Make illegal states unrepresentable.</strong> Prefer a type
            that cannot express the invalid case over a runtime check that
            rejects it. A caller should be unable to get it wrong, not merely
            told when they have.
        </li>
        <li>
            <strong>One obvious way to do each thing.</strong> Two paths to the
            same result doubles the surface, the documentation, and the ways to
            get it subtly wrong.
        </li>
        <li>
            <strong>Name things as the domain names them.</strong> The
            vocabulary of the interface is the vocabulary users will think in.
            Match the project's existing language exactly.
        </li>
        <li>
            <strong>Consistency beats local elegance.</strong> A slightly worse
            shape that matches its siblings is better than a better shape that
            is the only one of its kind.
        </li>
        <li>
            <strong>Errors are part of the interface.</strong> Decide what can
            fail, how it is reported, and what a caller can do about it. An
            error nobody can act on is a design gap.
        </li>
        <li>
            <strong>Defaults carry the design.</strong> The zero-configuration
            call should be the right thing for most callers. Every required
            parameter is a decision you have pushed onto everyone.
        </li>
    </ul>

    <h2>Stress-test it before committing</h2>

    <p>Walk the design through the futures you already know are coming:</p>

    <ul>
        <li>What happens when this needs to be asynchronous, batched, or paginated?</li>
        <li>What happens when a second implementation appears behind it?</li>
        <li>What breaks for existing callers if the obvious next feature lands?</li>
    </ul>

    <p>
        A shape that survives three imagined futures is probably right. One
        that needs a hole punched through it for the first is not.
    </p>

    <h2>What not to do</h2>

    <ul>
        <li><strong>Do not add parameters for hypothetical needs.</strong> Options added "for flexibility" become permanent surface nobody uses.</li>
        <li><strong>Do not leak implementation.</strong> If the caller must know what is inside to use it correctly, that knowledge is now part of your contract.</li>
        <li><strong>Do not return unstructured results.</strong> A shapeless object or a bare boolean pushes the interpretation problem onto every caller.</li>
        <li><strong>Do not use boolean parameters as mode switches.</strong> They read as nothing at the call site. Two functions, or a named option.</li>
    </ul>

    <p>
        Present the design and the rejected alternatives before implementing.
        The alternatives are the interesting part — they show what was traded.
    </p>
</template>
