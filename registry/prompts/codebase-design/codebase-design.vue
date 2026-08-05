<template>
    <h1>Codebase Design</h1>

    <p>
        Design <strong>deep modules</strong>: a lot of behaviour behind a small
        interface, placed at a clean seam, testable through that interface. The
        aim is leverage for callers, locality for maintainers, and testability
        for everyone.
    </p>

    <Glossary />

    <h2>Deep versus shallow</h2>

    <p>
        A <strong>deep</strong> module has a small interface and a large
        implementation — few methods, simple parameters, complex logic hidden
        behind them. A <strong>shallow</strong> module has a large interface
        and a thin implementation that mostly passes through. Shallow modules
        cost the caller everything they would have paid anyway, plus a layer to
        learn.
    </p>

    <p>When designing an interface, ask:</p>

    <ul>
        <li>Can I reduce the number of methods?</li>
        <li>Can I simplify the parameters?</li>
        <li>Can I hide more complexity inside?</li>
    </ul>

    <h2>Principles</h2>

    <ul>
        <li>
            <strong>Depth is a property of the interface, not the
            implementation.</strong> A deep module can be internally composed
            of small, swappable parts — they simply are not part of the
            interface. A module can have internal seams, private to its
            implementation and used by its own tests, as well as the external
            seam at its interface.
        </li>
        <li>
            <strong>The deletion test.</strong> Imagine deleting the module.
            If complexity vanishes, it was a pass-through. If complexity
            reappears across many callers, it was earning its keep.
        </li>
        <li>
            <strong>The interface is the test surface.</strong> Callers and
            tests cross the same seam. If you want to test <em>past</em> the
            interface, the module is probably the wrong shape.
        </li>
        <li>
            <strong>One adapter is a hypothetical seam; two adapters is a real
            one.</strong> Do not introduce a seam unless something actually
            varies across it.
        </li>
    </ul>

    <h2>Designing for testability</h2>

    <p>Good interfaces make testing natural. Three moves do most of the work:</p>

    <ol>
        <li>
            <strong>Accept dependencies, don't create them.</strong> A function
            handed its payment gateway is trivial to test; one that constructs
            its own is not.
        </li>
        <li>
            <strong>Return results, don't produce side effects.</strong>
            <code>calculateDiscount(cart): Discount</code> can be asserted on
            directly. <code>applyDiscount(cart): void</code> forces the test to
            go looking for what changed.
        </li>
        <li>
            <strong>Keep the surface small.</strong> Fewer methods mean fewer
            tests; fewer parameters mean simpler setup.
        </li>
    </ol>

    <h2>Rejected framings</h2>

    <p>These come up often enough to be worth ruling out explicitly:</p>

    <ul>
        <li>
            <strong>Depth as a ratio of implementation lines to interface
            lines.</strong> Rewards padding the implementation. Depth is
            leverage, not volume.
        </li>
        <li>
            <strong>"Interface" as the language keyword, or a class's public
            methods.</strong> Too narrow. The interface includes every fact a
            caller must know — invariants, ordering, error modes, performance.
        </li>
        <li>
            <strong>"Boundary".</strong> Overloaded. Say seam, or interface.
        </li>
    </ul>

    <h2>When applying this</h2>

    <p>
        Name the module, state its interface in one sentence, and say where the
        seam sits. If the sentence needs an "and" joining unrelated things, it
        is two modules. If you cannot state the interface without describing
        the implementation, the interface is not yet designed.
    </p>

    <p>
        Propose the reshaping before making it, and say what it costs. A
        redesign that improves depth but forces changes at thirty call sites is
        a different decision from one that does not.
    </p>
</template>
