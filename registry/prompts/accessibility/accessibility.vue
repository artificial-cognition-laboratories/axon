<template>
    <h1>Accessibility</h1>

    <p>
        Make the interface usable by people who navigate it differently — by
        keyboard, by screen reader, at high zoom, with low vision, or without
        colour perception. Most of this is correctness, not decoration.
    </p>

    <h2>Semantics first</h2>

    <p>
        The single highest-value move is using the right element. A native
        button is focusable, activated by both enter and space, announced as a
        button, and works with every assistive technology — none of which a
        clickable div gets, and all of which then has to be rebuilt by hand and
        will be rebuilt incompletely.
    </p>

    <ul>
        <li>Buttons for actions, links for navigation. The distinction is not cosmetic — they behave differently and are announced differently.</li>
        <li>Headings in order, describing real structure, not chosen for their size.</li>
        <li>Lists for lists, tables for tabular data with proper headers.</li>
        <li>Form controls with real labels, programmatically associated. Placeholder text is not a label.</li>
        <li>Landmarks for the page's regions, so a screen reader user can skip.</li>
    </ul>

    <p>
        Reach for ARIA only when no native element expresses it. Incorrect ARIA
        is worse than none, because it overrides what the browser would have
        conveyed correctly.
    </p>

    <h2>Keyboard</h2>

    <ul>
        <li>Everything interactive is reachable and operable by keyboard alone.</li>
        <li>Focus is always visible. Never remove the outline without replacing it with something at least as clear.</li>
        <li>Focus order follows visual order.</li>
        <li>Focus is managed at boundaries — moved into a dialog when it opens, restored to the trigger when it closes, and trapped while it is open.</li>
        <li>Nothing traps focus permanently. If it can be entered by keyboard, it can be left by keyboard.</li>
    </ul>

    <h2>Perception</h2>

    <ul>
        <li><strong>Contrast</strong> — meet the contrast requirements for text and for interface components. Check it rather than judging by eye.</li>
        <li><strong>Never colour alone.</strong> Any state signalled by colour needs a second signal: text, an icon, a pattern.</li>
        <li><strong>Text scales.</strong> The layout must survive substantial zoom and larger text without clipping or horizontal scrolling.</li>
        <li><strong>Images carry alt text</strong> that conveys their purpose. Decorative images are marked as decorative rather than described.</li>
        <li><strong>Respect reduced-motion preferences.</strong></li>
    </ul>

    <h2>Dynamic behaviour</h2>

    <ul>
        <li>Content that appears or changes without a page load is announced — errors, confirmations, loading states.</li>
        <li>Errors say what is wrong and how to fix it, are associated with their field, and are not conveyed by red borders alone.</li>
        <li>Nothing important is conveyed only on hover.</li>
    </ul>

    <h2>Verify, don't assume</h2>

    <p>
        Automated checks catch perhaps a third of real problems. Do the two
        manual passes that catch most of the rest: navigate the whole flow with
        only the keyboard, and check the accessible name and role of every
        interactive element.
    </p>

    <p>
        Report what you fixed, what remains, and what needs a human — anything
        depending on judgement about content, or on testing with an actual
        screen reader, should be named rather than quietly assumed fine.
    </p>
</template>
