<template>
    <h1>Type Modelling</h1>

    <p>
        Use the type system to make invalid states unrepresentable, so bugs
        become compile errors instead of runtime surprises. The measure of a
        good model is not how much it describes — it is how much it forbids.
    </p>

    <h2>The core move</h2>

    <p>
        When a runtime check exists to catch bad input, ask why the type
        allowed it. A function that must validate its arguments usually has the
        wrong signature: it is accepting a wider set of values than it can
        actually handle, and paying for that at runtime, forever, at every call
        site.
    </p>

    <p>
        Narrow at the boundary, once. Parse untrusted input into a precise
        shape at the seam where it arrives, then let everything downstream
        trust it. The alternative — passing loose data inward and checking it
        repeatedly — means every function carries the same defensive code and
        any one of them can forget.
    </p>

    <h2>Patterns</h2>

    <ul>
        <li>
            <strong>Union over flags.</strong> An object with a status field
            and four optionals that are only sometimes present should be a
            union of four shapes, each carrying exactly what it has. This
            eliminates the entire class of "checked the status but read the
            wrong field" bugs.
        </li>
        <li>
            <strong>Distinct types over primitives.</strong> A user identifier
            and an order identifier are both strings and are never
            interchangeable. Giving each its own type makes swapping them
            impossible rather than merely unlikely.
        </li>
        <li>
            <strong>Non-empty where empty is meaningless.</strong> If a
            function cannot do anything sensible with an empty collection, its
            input type should not permit one.
        </li>
        <li>
            <strong>Make the illegal combination unconstructible.</strong> If
            two fields must not both be set, do not document that — express it
            so the compiler enforces it.
        </li>
        <li>
            <strong>Exhaustiveness.</strong> Model variants so the compiler
            fails when a new case is added and some branch forgot it. This is
            most of the value of a union: adding a variant produces a list of
            everywhere that must change.
        </li>
    </ul>

    <h2>What defeats the point</h2>

    <ul>
        <li>
            <strong>Escape hatches.</strong> A cast or an assertion silencing a
            mismatch is the type system telling you two shapes disagree, and
            you overruling it. One of them is wrong. Fix that instead.
        </li>
        <li>
            <strong>Optional as a shrug.</strong> Marking a field optional
            because it is sometimes absent, rather than modelling <em>why</em>,
            pushes a null check to every reader forever.
        </li>
        <li>
            <strong>Stringly-typed values.</strong> A string holding one of
            five known values is a union that has not been written down.
        </li>
        <li>
            <strong>Types that lie.</strong> A signature promising something
            the implementation does not deliver is worse than an honest wide
            type, because everyone downstream now trusts it.
        </li>
    </ul>

    <h2>Know when to stop</h2>

    <p>
        Type modelling has a point of diminishing returns, and it arrives
        earlier than enthusiasts think. If the type is harder to understand
        than the bug it prevents, it is not paying for itself. If a reader
        needs to decode three layers of generics to call a function, the
        cleverness has become the problem.
    </p>

    <p>
        Aim at the invalid states that would actually occur and cause real
        damage. Not every conceivable misuse is worth encoding.
    </p>
</template>
