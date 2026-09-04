/**
 * subagents — delegate work to another agent, and wait for its answer.
 *
 * ── Why this shells out ────────────────────────────────────────────────────
 *
 * There is no in-process route to spawn an agent any more: supervision belongs
 * to the daemon, and an agent asking for a child asks the same way anything
 * else does — through the CLI. `axon` is on PATH, it is mediated by the same
 * `shell.run` policy as every other command this agent runs, and its spans
 * land on the timeline and in the flame graph with no extra plumbing.
 *
 * That makes this module thin by design. It is not the mechanism; it is the
 * DISCOVERABILITY of the mechanism. An agent can already type the command —
 * but no model has `axon` in its training set, so without a declared tool the
 * capability is invisible. Documenting the CLI in a prompt would be worse: it
 * is a wall of text that competes with the task.
 *
 * ── The parent link is what makes a subagent a subagent ────────────────────
 *
 * `--parent` is not decoration. Without it the spawn is a ROOT: it renders
 * flat in the agent tree instead of nested, and it outlives the agent that
 * asked for it because nothing connects them. `AXON_SESSION_ID` is how a
 * running agent names itself, and the daemon resolves the link — this process
 * cannot, since the parent is alive in a different one.
 */
export const subagents = {
    /**
     * Ask an agent to do something, and return what it said.
     *
     * BLOCKING, deliberately: a subagent is work you are waiting on, and the
     * answer is the point. `process.run` streams its lifecycle as ordinary
     * proc events, so a long delegation is visible rather than a silent gap.
     *
     * @param prompt What to ask. Used verbatim.
     * @param agent  Which agent — `@scope/name`, a path, or `.` for a copy of
     *               this one. Defaults to this agent, which is the common case:
     *               fan out the work you are already doing.
     */
    async request(prompt: string, agent: string = "."): Promise<string> {
        const parent = process.env.AXON_SESSION_ID
        const command = [
            "axon",
            agent,
            "-p", JSON.stringify(prompt),
            "--json",
            ...(parent ? ["--parent", parent] : []),
        ].join(" ")

        const result = await process.run(command)

        // A refusal, a missing binary and a crashed agent all arrive here.
        // Thrown rather than returned as text: the caller asked for an answer
        // and there isn't one, and handing back an error string would let it
        // flow into a prompt as though the subagent had said it.
        if (!result.ok) {
            throw new Error(result.err || result.stderr.trim() || `subagent exited ${result.exitCode}`)
        }

        /**
         * A parse failure here is almost never malformed JSON — it is an
         * `axon` that did not honour `--json` and streamed prose instead.
         *
         * That happens whenever the CLI on PATH predates the flag: an unknown
         * flag is currently ignored rather than refused, so there is no signal
         * to detect except the shape of what comes back. Surfacing the raw
         * parser error (`Unexpected identifier "hello"`) points at the answer's
         * first word and says nothing about the cause; naming the skew is the
         * difference between a five-second fix and a hunt.
         */
        let parsed: { text?: string; error?: { message?: string } }
        try {
            parsed = JSON.parse(result.stdout)
        } catch {
            throw new Error(
                "subagent did not return JSON — the `axon` on PATH may predate `--json`."
                + ` Run \`axon --version\`. It replied: ${result.stdout.trim().slice(0, 120)}`,
            )
        }

        if (parsed.error) throw new Error(parsed.error.message ?? "subagent failed")
        return parsed.text ?? ""
    },
}
