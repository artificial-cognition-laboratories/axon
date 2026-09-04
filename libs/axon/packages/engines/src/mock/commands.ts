import { run, type MockInput } from "./mock"

/**
 * The default script every implicit `Mock()` answers with.
 *
 * ── Why a default at all ────────────────────────────────────────────────────
 *
 * `mock` is in every pool without being declared (see providerPool), so
 * `*mock:mock` is always one keystroke away. A mock that echoed the prompt back
 * — the previous bare-`Mock()` behaviour — is a route that exists and does
 * nothing worth doing.
 *
 * These are the UI surfaces you cannot easily provoke on purpose. Reproducing a
 * denied tool call, a non-zero exit, or a reply long enough to wrap normally
 * means finding a real task that happens to fail the right way; each of these
 * is one command. They are also how the terminal is tested without spending a
 * token or depending on a provider being up — which is exactly when you want
 * them, because "the model is unavailable" is often the reason you are looking.
 *
 * ── The set ─────────────────────────────────────────────────────────────────
 *
 * Small and ORTHOGONAL: one command per distinct surface, nothing that is two
 * others in a trenchcoat. Matched as substrings (Script's map form), so
 * `hello` and a sentence containing "hello" both hit — the leading slash is a
 * convention for the user's benefit, not a parser rule.
 *
 * A user passing their own `Mock({...})` replaces this entirely, which is the
 * override the pool's dedup already gives them.
 */
export const MOCK_COMMANDS: MockInput = {
    /** Plain reply. The baseline: text, then the turn ends. */
    "mock-hello": "Hello — the mock engine is answering. Nothing was billed and no provider was contacted.",

    /** A successful block: the `Run(...)` row, its stdout, and a conclusion. */
    "call-tool": [
        run(`const files = ["axon.config.ts", "package.json", "README.md"];\n({ found: files.length, files })`),
        "Three files, as the block reported.",
    ],

    /**
     * A block that THROWS.
     *
     * The red `Run(...)` prefix, the error row beneath it, and — the part
     * worth demonstrating — the turn carrying on afterwards rather than
     * stopping. A thrown tool call is the ordinary path.
     */
    "fail-tool": [
        run(`JSON.parse("{ not json");`),
        "That block threw. The failure is the ordinary path — I read the error and carry on.",
    ],

    /**
     * A non-zero exit from a spawned process.
     *
     * Distinct from `fail-tool`: the block itself SUCCEEDS, and the failure is
     * in the result it returns. Different row, different rendering, and the one
     * people conflate.
     */
    "fail-bash": [
        run(`await process.run("exit 3")`),
        "The command exited 3. The block ran fine — the process it started did not.",
    ],

    /**
     * A refusal by policy.
     *
     * `git` is the example because it is the one a user is most likely to have
     * actually denied. Renders the denial row rather than an error: a refusal
     * is a settled answer, not a fault to work around.
     */
    "deny-tool": [
        run(`await process.run("git push --force")`),
        "Policy refused that. It is a settled answer, so I have not looked for another way to run it.",
    ],

    /**
     * A long reply, for streaming and wrapping.
     *
     * Long enough to exceed a viewport and force the scrollbar, which is what
     * makes it the fixture for scroll, follow, and text-wrap behaviour.
     */
    "stream": [
        // The long text is the FIRST step, not a later one. A sequence yields
        // one step per turn, so a short opener would mean the command's whole
        // purpose — a reply that actually wraps and scrolls — arrived on the
        // second press. Nobody presses it twice.
        [
            "Streaming a long reply so the terminal has something to wrap, scroll and follow.",
            "",
            "The renderer paints chunks as they arrive rather than waiting for the whole message, so a slow provider shows its first words immediately instead of a blank pane. Wrapping happens at the paintable width, which is narrower than the container whenever a scrollbar is present — two columns narrower, and getting that wrong deletes the tail of every line.",
            "",
            "Auto-follow pins the view to the bottom while you are at the bottom, and detaches the moment you scroll away, whether by wheel or by dragging the scrollbar. Scroll up while this is being written and the view should stay where you put it; scroll back down and it should resume following.",
            "",
            "Long enough, by now, to exceed a viewport and force the scrollbar into existence — which is the state most of the rendering bugs worth catching only appear in.",
        ].join("\n"),
        "That is the end of the long reply.",
    ],

    /**
     * Several turns of real work: look, decide, act, report.
     *
     * The shape a task actually takes, and the one place `<done/>` only appears
     * at the end. Also the fixture for turn timings, which need more than one
     * turn to be worth reading.
     */
    "multi-turn": [
        run(`({ step: 1, checking: "the first thing" })`),
        run(`({ step: 2, using: "what step 1 returned" })`),
        run(`({ step: 3, done: true })`),
        "Three steps, each one waiting on what the last returned.",
    ],

    /**
     * A block long enough to interrupt.
     *
     * The only way to exercise Escape deliberately: the interrupt row, the
     * spinner settling, and the queue flushing into the next wake all need a
     * turn that is still running when you press it.
     */
    "interrupt-me": [
        run(`await new Promise(resolve => setTimeout(resolve, 60_000))`),
        "Picked up where that left off.",
    ],

    /** What the mock can do, from the mock itself. */
    "help": [
        [
            "Mock commands — no provider is contacted and nothing is billed.",
            "",
            "- `mock-hello` — a plain reply",
            "- `call-tool` — a block that succeeds",
            "- `fail-tool` — a block that throws",
            "- `fail-bash` — a process that exits non-zero",
            "- `deny-tool` — a call refused by policy",
            "- `stream` — a long reply, for scroll and wrap",
            "- `multi-turn` — several dependent steps",
            "- `interrupt-me` — a long block, for Escape",
        ].join("\n"),
    ],
}
