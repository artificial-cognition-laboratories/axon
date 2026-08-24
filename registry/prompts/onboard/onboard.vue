<template>
    <h1>Onboard</h1>

    <p>
        Build an accurate mental model of an unfamiliar codebase, fast enough
        to be useful and honestly enough to be trusted.
    </p>

    <h2>Read in this order</h2>

    <p>
        Breadth before depth. The goal of the first pass is a map, not
        understanding — knowing where things are beats knowing how one of them
        works.
    </p>

    <ol>
        <li><strong>The README and any architecture or contributor docs.</strong> Start with what the project says about itself, while treating it as a claim to verify rather than fact.</li>
        <li><strong>The manifest.</strong> Dependencies tell you what kind of system this is, and the scripts tell you how it is built, tested, and run.</li>
        <li><strong>The directory layout, one level deep.</strong> Where does code live, where do tests live, what are the top-level concepts?</li>
        <li><strong>The entry points.</strong> What runs first — the server, the CLI, the main function. Follow one request or command all the way through.</li>
        <li><strong>The data model.</strong> Schemas and core types are usually the fastest route to the domain, because they encode what the system actually thinks exists.</li>
        <li><strong>The tests.</strong> Often the best documentation available: they state what is meant to happen, and they cannot be out of date the way prose can.</li>
    </ol>

    <h2>Then trace one path end to end</h2>

    <p>
        Pick a single real operation and follow it completely, from entry to
        persistence and back. One traced path teaches more about the
        architecture than an hour of skimming, because it forces you through
        every layer the system actually has rather than the ones it claims.
    </p>

    <h2>What to look for</h2>

    <ul>
        <li><strong>The domain vocabulary</strong> — the words this codebase uses, and what they mean here specifically. Getting these wrong makes every later conversation harder.</li>
        <li><strong>Conventions</strong> — how modules are shaped, how errors are handled, how things are named. Enough to write code that reads like it belongs.</li>
        <li><strong>The seams</strong> — where the system talks to the outside world.</li>
        <li><strong>Where the complexity actually is</strong> — the files that are large, changed often, or full of comments explaining why. That is where the real system lives.</li>
        <li><strong>What contradicts the docs.</strong> Drift between documentation and code is normal, and finding it early is genuinely valuable to the team.</li>
    </ul>

    <h2>Report what you learned — and what you did not</h2>

    <p>Produce a map someone else could use:</p>

    <ul>
        <li>What this system does, in a paragraph.</li>
        <li>The main components and how they relate.</li>
        <li>The vocabulary, with the project's own definitions.</li>
        <li>How to run it, test it, and make a change.</li>
        <li><strong>What you are still unsure about</strong>, specifically.</li>
    </ul>

    <p>
        That last section is the important one. Confidently describing a system
        you have half-understood is how a wrong mental model spreads to
        everyone who reads your summary. Where you inferred rather than
        verified, say which.
    </p>
</template>
