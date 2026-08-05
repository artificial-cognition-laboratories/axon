<template>
    <section>
        <h2>Glossary</h2>

        <p>
            Use these terms exactly. Do not substitute "component", "service",
            "API", or "boundary" — consistent language is the whole point of
            having the vocabulary at all.
        </p>

        <ul>
            <li>
                <strong>Module</strong> — anything with an interface and an
                implementation. Deliberately scale-agnostic: a function, a
                class, a package, or a slice spanning several tiers.
                <em>Avoid:</em> unit, component, service.
            </li>
            <li>
                <strong>Interface</strong> — everything a caller must know to
                use the module correctly. The type signature, but also
                invariants, ordering constraints, error modes, required
                configuration, and performance characteristics.
                <em>Avoid:</em> API, signature — both too narrow, referring
                only to the type-level surface.
            </li>
            <li>
                <strong>Implementation</strong> — what is inside a module.
                Distinct from an adapter: a thing can be a small adapter with
                a large implementation (a Postgres repository) or a large
                adapter with a small one (an in-memory fake). Say "adapter"
                when the seam is the topic, "implementation" otherwise.
            </li>
            <li>
                <strong>Depth</strong> — leverage at the interface: how much
                behaviour a caller or a test can exercise per unit of
                interface they must learn. A module is <em>deep</em> when a
                lot of behaviour sits behind a small interface,
                <em>shallow</em> when the interface is nearly as complex as
                the implementation.
            </li>
            <li>
                <strong>Seam</strong> — a place where behaviour can be altered
                without editing in that place; the location at which a
                module's interface lives. Where to put the seam is its own
                design decision, separate from what goes behind it.
                <em>Avoid:</em> boundary — overloaded with bounded context.
            </li>
            <li>
                <strong>Adapter</strong> — a concrete thing satisfying an
                interface at a seam. Describes the role it fills, not what is
                inside it.
            </li>
            <li>
                <strong>Leverage</strong> — what callers get from depth: more
                capability per unit of interface learned. One implementation
                pays back across every call site and every test.
            </li>
            <li>
                <strong>Locality</strong> — what maintainers get from depth:
                change, bugs, knowledge, and verification concentrate in one
                place instead of spreading across callers. Fix once, fixed
                everywhere.
            </li>
        </ul>

        <h3>Relationships</h3>

        <ul>
            <li>A module has exactly one interface — the surface it presents to callers and tests.</li>
            <li>Depth is a property of a module, measured against its interface.</li>
            <li>A seam is where a module's interface lives.</li>
            <li>An adapter sits at a seam and satisfies the interface.</li>
            <li>Depth produces leverage for callers and locality for maintainers.</li>
        </ul>
    </section>
</template>
