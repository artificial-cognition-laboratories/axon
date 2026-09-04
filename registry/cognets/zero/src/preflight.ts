import type { PreflightTurn } from "@arcforge/air"

/**
 * The opening exchange — what the agent has already seen itself do.
 *
 * ── Why this is content and not prose ───────────────────────────────────────
 *
 * The contract DESCRIBES the grammar; this DEMONSTRATES it. That distinction
 * is not stylistic. `DONE_RULE` already states, in almost these words, that
 * announcing work is not doing it — "I will now trace Y" followed by `<done/>`
 * is called out explicitly — and a capable model did exactly that anyway,
 * twice in one session, leaving the user staring at a stated intention nobody
 * was acting on.
 *
 * A rule in a system block loses to a prior. Models are trained on chat, and
 * chat acknowledges in one turn and acts in the next. What beats a prior is
 * not a firmer rule; it is a conversation the model can continue, because
 * continuation is the thing it does. So every failure mode worth preventing is
 * shown here happening, and being handled, rather than being forbidden.
 *
 * A demonstrated trajectory also outlives a stated one. A rule decays as it
 * slides out of attention; a pattern held for tens of thousands of tokens no
 * longer needs the turns that started it.
 *
 * ── The shape ───────────────────────────────────────────────────────────────
 *
 * SEVERAL SHORT EXCHANGES, not one long one. Each teaches one thing and ends
 * cleanly, so the model sees the whole arc — request, work, result, handback —
 * repeatedly rather than once. A single long exchange demonstrates the middle
 * of a task far more often than either edge.
 *
 * Order is deliberate: the rhythm first, then the failure it most often gets
 * wrong, then the recoveries. The interrupt is last because nothing the agent
 * says may follow one.
 *
 * ── What is deliberately NOT here ───────────────────────────────────────────
 *
 * No `fs`, no `process`, beyond what any agent has. A preflight that called a
 * tool would demonstrate an API a given agent may not have installed, and the
 * one thing worse than a missing demonstration is one that teaches a call that
 * throws.
 *
 * No distinctive voice. Every phrasing choice here is a trajectory the model
 * continues — which is the mechanism working, and also means this doubles as a
 * personality. Kept plain until that is a decision someone is making on
 * purpose rather than a side effect of how these sentences were typed.
 *
 * No marker saying these are examples. Few-shot works because the turns are
 * indistinguishable from real ones; labelling them invites the model to
 * discount them, and every attribute invented here is one more thing it may
 * copy into its own output.
 */
export const ZERO_PREFLIGHT: readonly PreflightTurn[] = [
    // ── 1. The rhythm ───────────────────────────────────────────────────────
    //
    // A systems check is the one exchange that can precede ANY conversation
    // without steering it: the subject is the agent's own machine, so it
    // establishes rhythm without establishing topic.
    //
    // Speak briefly, then act. ONE script, its result comes back, only then a
    // conclusion. The multi-script habit is a model trying to do all of this
    // in one message, and seeing it done properly once is worth more than a
    // rule stating it twice.
    { kind: "user", content: "run a quick systems check before we start" },
    { kind: "text", content: "Running a preflight now." },
    {
        kind: "script",
        id: "p1",
        code: [
            `const started = Date.now();`,
            `globalThis.__preflight = { started };`,
            `({ runtime: typeof process !== "undefined" ? process.version : "unknown", started })`,
        ].join("\n"),
    },
    { kind: "stdout", for: "p1", lang: "json", content: `{"runtime":"v1.3.14","started":1757000000000}` },

    // Independent work BATCHES. The lesson is "one step per message", not
    // "never do two things" — without this, a model correcting itself away
    // from four scripts has nowhere to put legitimate parallel work.
    {
        kind: "script",
        id: "p2",
        code: [
            `// Independent checks, so they go together in ONE block.`,
            `const [maths, strings, async_] = await Promise.all([`,
            `    Promise.resolve(2 + 2 === 4),`,
            `    Promise.resolve("axon".toUpperCase() === "AXON"),`,
            `    (async () => { await Promise.resolve(); return true })(),`,
            `]);`,
            `({ maths, strings, async: async_, scopePersisted: globalThis.__preflight !== undefined })`,
        ].join("\n"),
    },
    // Speech placed AFTER the script, so this message ends on `</text>` with
    // no `<done/>` — the FIRST thing the model reads is a turn where the agent
    // says something and carries straight on. Position matters here: this is
    // the opening exchange, and the shape it establishes is the one every
    // later turn is read against.
    { kind: "text", content: "Runtime is up. Checking that scope persists across blocks and that async resolves." },
    { kind: "stdout", for: "p2", lang: "json", content: `{"maths":true,"strings":true,"async":true,"scopePersisted":true}` },

    // The turn ENDS here, and only here. Everything above was one turn.
    { kind: "text", content: "All green. Runtime is up, scope persists across blocks, async resolves." },
    { kind: "done" },

    // ── 2. Stopping too early, and being corrected ──────────────────────────
    //
    // THE reported failure, shown happening. The agent announces work, hands
    // control back, and does nothing — the exact shape DONE_RULE forbids in
    // prose and a model produced anyway.
    //
    // Shown ONCE. Twice would read as "stopping early is normal here", which
    // is the opposite of the lesson. The correction is explicit rather than a
    // nudge: a user typing "..." is a real signal but a weak teacher, and the
    // point of this turn is to LABEL the mistake so the model can recognise
    // it in itself.
    { kind: "user", content: "how many blocks can you send in one message?" },
    { kind: "text", content: "Let me check the contract and get back to you." },
    { kind: "done" },
    {
        kind: "user",
        content: "You stopped without doing anything. Saying what you are about to do is not doing it — run the work in the same message, or say nothing and run it.",
    },
    // The recovery RUNS the work it announces, in the same message, and does
    // NOT hand back. An earlier version of this turn answered from memory and
    // emitted `<done/>` — which restated the lesson in the exact shape it was
    // correcting, and was the single most misleading turn in the preflight.
    { kind: "text", content: "You're right — checking rather than telling you I will." },
    {
        kind: "script",
        id: "p9",
        code: `({ text: 1, script: 1, parallel: "same message runs together" })`,
    },
    { kind: "stdout", for: "p9", lang: "json", content: `{"text":1,"script":1,"parallel":"same message runs together"}` },
    {
        kind: "text",
        content: "One `<text>` and one `<script>` per message, either optional. Several scripts in one message run at the same time, so a later one cannot use what an earlier one wrote.",
    },
    { kind: "done" },

    // ── 3. The protocol, in the agent's own voice ───────────────────────────
    //
    // Different from the contract stating it: this is a turn the model
    // continues from rather than a rule it reads. Asking in-band also makes
    // the answer available to a user who asks the same question for real.
    { kind: "user", content: "show me the stopping protocol" },
    {
        kind: "text",
        content: [
            "`<done/>` means *I am handing control back*, not *the task is complete*.",
            "",
            "- Ending a reply: `<done/>`.",
            "- Running code whose result I need before continuing: `<done/>` — the result comes back on my next turn.",
            "- Reporting progress mid-task: no `<done/>`, and I keep working.",
            "- Announcing what I am about to do: no `<done/>`, because the doing belongs in the same message.",
        ].join("\n"),
    },
    // Demonstrates its own last bullet rather than stopping on it. The prose
    // above says speech is not terminal; a `<done/>` here would have said the
    // opposite in the same breath, which is a contradiction the model reads in
    // one render and resolves by copying the shape, not the words.
    {
        kind: "script",
        id: "p10",
        code: `({ handingBack: "<done/>", stillWorking: "no <done/>" })`,
    },
    { kind: "stdout", for: "p10", lang: "json", content: `{"handingBack":"<done/>","stillWorking":"no <done/>"}` },
    { kind: "text", content: "That is the whole rule — the tag marks the handback, not the finish line." },
    { kind: "done" },

    // ── 4. Work that spans turns without stopping ──────────────────────────
    //
    // "Speaking does not end your turn" is stated in the rules and is hard to
    // believe from a rule alone. Here it is done: three turns of look → decide
    // → act, with progress reported in the middle and `<done/>` only at the
    // end.
    // This is the LONGEST exchange here, deliberately. It is the only one
    // demonstrating that speech is not terminal, and it has to outweigh six
    // short turns that each end on a reply — a lesson carried by one throwaway
    // line loses to a shape repeated everywhere else.
    { kind: "user", content: "how long has this session been up, and is that consistent with the recorded start?" },
    {
        kind: "script",
        id: "p3",
        code: `({ startedAt: globalThis.__preflight.started, now: Date.now() })`,
    },
    { kind: "stdout", for: "p3", lang: "json", content: `{"startedAt":1757000000000,"now":1757000041000}` },

    // ── THE SHAPE THIS SCENARIO EXISTS FOR ──────────────────────────────────
    //
    // Each script is followed by SPEECH, so the message ENDS ON `</text>`
    // WITH NO `<done/>` — and the run carries on into the next result.
    //
    // Every message here used to put its text FIRST, before the script. That
    // reads fine and taught the wrong thing: a message ending on `</script>`
    // continues because a result is owed, not because the agent chose to keep
    // going. So across the whole preflight there were 13 messages ending
    // without `<done/>` and every one of them ended on a script — zero ended
    // on speech. The model learned an exact and consistent rule from that:
    // SPEAKING LAST MEANS HANDING BACK. It then stopped after the first reply
    // to almost any request, which is the bug this ordering fixes.
    //
    // Saying what a result means, then continuing, is the single most common
    // move in a long run. It has to be demonstrated, not just permitted.
    { kind: "text", content: "Got the timestamps. Converting to seconds now." },
    {
        kind: "script",
        id: "p4",
        code: [
            `const ms = Date.now() - globalThis.__preflight.started;`,
            `({ seconds: Math.round(ms / 1000) })`,
        ].join("\n"),
    },
    { kind: "text", content: "That gives me the uptime. Cross-checking it against the recorded start before I answer." },
    { kind: "stdout", for: "p4", lang: "json", content: `{"seconds":41}` },
    {
        kind: "script",
        id: "p11",
        code: [
            `const recorded = globalThis.__preflight.started;`,
            `const derived = Date.now() - 41_000;`,
            `({ recorded, derived, driftMs: Math.abs(recorded - derived) })`,
        ].join("\n"),
    },
    { kind: "text", content: "41 seconds, and no drift against the recorded start. One more check: that the clock was not stepped underneath us." },
    { kind: "stdout", for: "p11", lang: "json", content: `{"recorded":1757000000000,"derived":1757000000000,"driftMs":0}` },
    {
        kind: "script",
        id: "p12",
        code: `({ monotonic: typeof performance?.now === "function" })`,
    },
    { kind: "stdout", for: "p12", lang: "json", content: `{"monotonic":true}` },
    { kind: "text", content: "Up 41 seconds, consistent with the recorded start and no clock step." },
    { kind: "done" },

    // ── 5. A block that throws ──────────────────────────────────────────────
    //
    // A failing block is the ORDINARY path, not an incident. What the model
    // must not do is apologise, stop, or retry the same call unchanged — the
    // response is to read the error and adapt, in the very next block.
    { kind: "user", content: "what version of the config schema is this project on?" },
    {
        kind: "script",
        id: "p5",
        code: `JSON.parse(globalThis.__missing ?? "")`,
    },
    {
        kind: "stdout",
        for: "p5",
        ok: false,
        lang: "txt",
        content: "",
        error: { kind: "exception", message: `SyntaxError: Unexpected end of JSON input` },
    },
    // Names what the failure MEANS and keeps going — the message ends on
    // speech, no `<done/>`. This is the moment a model is most tempted to hand
    // back ("I hit an error, over to you"), so it is the most valuable place to
    // show the opposite.
    // Reads the error, changes approach, same turn. No apology, no stop.
    {
        kind: "script",
        id: "p6",
        // Semicolon before the parenthesised expression: without it,
        // `const raw = x` followed by `({...})` parses as a CALL of x. A
        // preflight that demonstrates broken JavaScript teaches broken
        // JavaScript.
        code: [
            `const raw = globalThis.__missing;`,
            `({ present: raw !== undefined, value: raw ?? null })`,
        ].join("\n"),
    },
    // Speech AFTER the script, so the message ends on `</text>` with no
    // `<done/>` and the run continues into the result below. A model is most
    // tempted to hand back right after an error ("I hit a problem, over to
    // you"), which makes this the most valuable place to demonstrate the
    // opposite.
    { kind: "text", content: "That threw because the value is unset rather than malformed. Reading it directly instead of parsing it." },
    { kind: "stdout", for: "p6", lang: "json", content: `{"present":false,"value":null}` },
    { kind: "text", content: "Nothing is set there — the value does not exist rather than being malformed." },
    { kind: "done" },

    // ── 6. A refusal by policy ──────────────────────────────────────────────
    //
    // A denial is a SETTLED ANSWER, not an error to work around. The failure
    // mode this pre-empts is the model treating a refusal as a puzzle and
    // reaching for another spelling of the same call — which is precisely the
    // behaviour a policy exists to stop.
    // Ends on a SCRIPT, with no text before the handback. Everywhere else
    // `<done/>` follows speech, which silently teaches that the two go
    // together — the exact confound that makes a model treat finishing a
    // sentence as finishing a turn. Here the turn ends because the work is
    // handed over, and nothing is said at all.
    { kind: "user", content: "stash the current check under a key I can read back later" },
    {
        kind: "script",
        id: "p13",
        code: [
            `globalThis.__preflight.lastCheck = { uptimeSeconds: 41, ok: true };`,
            `({ stored: "lastCheck" })`,
        ].join("\n"),
    },
    { kind: "stdout", for: "p13", lang: "json", content: `{"stored":"lastCheck"}` },
    { kind: "done" },

    { kind: "user", content: "check the git status of this repo" },
    {
        kind: "script",
        id: "p7",
        code: `await process.run("git status --short")`,
    },
    {
        kind: "stdout",
        for: "p7",
        ok: false,
        lang: "txt",
        content: "",
        error: { kind: "policy", message: `shell.run:git denied by policy` },
    },
    {
        kind: "text",
        content: "Policy here does not allow `git`, so I have not run it. If you want that check, enable it in the agent's policy and ask me again.",
    },
    { kind: "done" },

    // ── 7. An interrupt ─────────────────────────────────────────────────────
    //
    // A run cut short. Demonstrated rather than described because an interrupt
    // is a thing that HAPPENS to the agent mid-turn, and a model that has
    // never seen one reads it as a failure of its own — retrying the work it
    // was just told to stop, which is the worst possible response.
    //
    // Placed last, and NOTHING THE AGENT SAYS FOLLOWS IT. On abort the wake
    // commits the interrupt and closes its channel, so the cognet returns
    // without another inference: in every real session the next thing is the
    // user speaking again (verified across every session on this machine — 15
    // interrupts, 15 followed by a user turn, never an agent one). Ending here
    // means the last thing the agent sees before the real conversation is
    // exactly what an interrupted agent sees in production.
    { kind: "user", content: "wait for the deploy to settle before we carry on" },
    {
        kind: "script",
        id: "p8",
        code: `await new Promise(resolve => setTimeout(resolve, 60_000))`,
    },
    { kind: "interrupt", from: "terminal" },
]
