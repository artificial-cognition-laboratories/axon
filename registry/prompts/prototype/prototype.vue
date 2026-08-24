<template>
    <h1>Prototype</h1>

    <p>
        A prototype is <strong>throwaway code that answers a question</strong>.
        The question decides its shape, and knowing which question is being
        asked is most of the work.
    </p>

    <h2>Identify the question first</h2>

    <p>Prototypes answer one of two very different things:</p>

    <ul>
        <li>
            <strong>"Does this logic or state model feel right?"</strong> Build
            a tiny interactive program that pushes the state machine through
            the cases that are hard to reason about on paper. Drive it from the
            terminal; print the whole relevant state after every action.
        </li>
        <li>
            <strong>"What should this look like?"</strong> Build several
            genuinely different variations side by side, switchable without a
            rebuild, so they can be compared directly rather than remembered.
        </li>
    </ul>

    <p>
        These produce completely different artifacts, so getting it wrong
        wastes the whole exercise. If the question is ambiguous and nobody is
        reachable, pick from the surrounding code — a backend module implies
        logic, a page or component implies interface — and state the assumption
        at the top of what you build.
    </p>

    <h2>Rules</h2>

    <ol>
        <li>
            <strong>Throwaway from day one, and visibly so.</strong> Put it
            near the code it is prototyping for, so the context is obvious, but
            name it so no reader could mistake it for production. Follow the
            project's existing conventions for where such things live.
        </li>
        <li>
            <strong>One command to run it.</strong> Whatever the project's task
            runner already supports. Someone must be able to start it without
            thinking.
        </li>
        <li>
            <strong>No persistence by default.</strong> Keep state in memory.
            Persistence is usually the thing being questioned, not something to
            depend on. If the question genuinely involves storage, use a
            scratch location named so it is obviously disposable.
        </li>
        <li>
            <strong>Skip the polish.</strong> No tests, no abstractions, no
            error handling beyond what keeps it running. The point is to learn
            something quickly — production instincts actively cost you here.
        </li>
        <li>
            <strong>Surface the state.</strong> After every action, show
            everything relevant. A prototype you have to inspect with a
            debugger has failed at its one job.
        </li>
        <li>
            <strong>Capture the answer when done.</strong> Fold the validated
            decision into the real code, and record the verdict and the
            question it settled somewhere durable. Keep the prototype itself
            out of the main line of work.
        </li>
    </ol>

    <h2>Finishing</h2>

    <p>
        State plainly what the prototype showed — including when it showed the
        idea does not work. A prototype that kills a design has done its job
        perfectly, and reporting that outcome as a failure is how the lesson
        gets lost.
    </p>

    <p>
        Then delete it, or move it out of the way. Prototype code that lingers
        gets read as an example and copied.
    </p>
</template>
