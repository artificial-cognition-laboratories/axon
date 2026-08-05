<template>
    <section>
        <h3>The smell baseline</h3>

        <p>
            On top of whatever the repo documents, the Standards axis always
            carries this fixed set of code smells, so it still has something
            to say when a repo documents nothing. Two rules bind it:
        </p>

        <ul>
            <li><strong>The repo overrides.</strong> A documented repo standard always wins. Where it endorses something this list would flag, suppress the smell.</li>
            <li><strong>Always a judgement call.</strong> Each item is a labelled heuristic — "possible Feature Envy" — never a hard violation. As with any standard, skip anything tooling already enforces.</li>
        </ul>

        <p>Each reads <em>what it is</em> → <em>how to fix it</em>. Match them against the diff:</p>

        <ul>
            <li><strong>Mysterious Name</strong> — a function, variable, or type whose name doesn't reveal what it does or holds. → Rename it; if no honest name comes, the design is murky.</li>
            <li><strong>Duplicated Code</strong> — the same logic shape appears in more than one hunk or file in the change. → Extract the shared shape, call it from both.</li>
            <li><strong>Feature Envy</strong> — a method that reaches into another object's data more than its own. → Move the method onto the data it envies.</li>
            <li><strong>Data Clumps</strong> — the same few fields or parameters keep travelling together, a type wanting to be born. → Bundle them into one type and pass that.</li>
            <li><strong>Primitive Obsession</strong> — a primitive or string standing in for a domain concept that deserves its own type. → Give the concept its own small type.</li>
            <li><strong>Repeated Switches</strong> — the same switch or if-cascade on the same type recurs across the change. → Replace with polymorphism, or one map both sites share.</li>
            <li><strong>Shotgun Surgery</strong> — one logical change forces scattered edits across many files. → Gather what changes together into one module.</li>
            <li><strong>Divergent Change</strong> — one file or module is edited for several unrelated reasons. → Split it so each module changes for one reason.</li>
            <li><strong>Speculative Generality</strong> — abstraction, parameters, or hooks added for needs the spec doesn't have. → Delete it; inline back until a real need shows.</li>
            <li><strong>Message Chains</strong> — long <code>a.b().c().d()</code> navigation the caller shouldn't depend on. → Hide the walk behind one method on the first object.</li>
            <li><strong>Middle Man</strong> — a class or function that mostly just delegates onward. → Cut it; call the real target directly.</li>
            <li><strong>Refused Bequest</strong> — a subclass or implementer that ignores or overrides most of what it inherits. → Drop the inheritance, use composition.</li>
        </ul>
    </section>
</template>
