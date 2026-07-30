import { Mock, run } from "@arcforge/engines"

/**
 * What this benchmark measures.
 *
 * The schema is a TypeScript type rather than a config block: a doc comment is
 * where a description naturally lives, and a union is how anyone would write a
 * category. `axon bench prepare` extracts it into .bench/schema.json so the
 * manifest carries the schema as a value — coverage can only report "expected
 * 4, observed 3" if it knows about measurements that never fired.
 */
type Schema = {
    /** Has the agent resolved the bug? */
    resolved: boolean

    /** Files edited beyond the target. @objective minimize */
    collateral: number
}

export default defineBench<Schema>({
    // One world, copied fresh per iteration. The agent sees this and nothing
    // else — fixtures/ is author-side only.
    workspace: { source: "./workspace", retain: "failed" },

    // Every key is an axis; two keys means every combination. One key is the
    // controlled single-variable case, which is the one to reach for first.
    //
    // Mock() varies BEHAVIOUR, not just labels, so the full flow — expansion,
    // binding, measurement, replay — runs with a real pass/fail spread and no
    // live API calls.
    matrix: {
        // The agent under test. Held constant — only the model varies, which
        // is what makes any difference in the results attributable to it.
        agent: "./fixtures/subject",

        model: [
            // Known-good: writes the correct fix, so `resolved` must be true.
            Mock({ fix: run(`await Bun.write("src/parser.ts", 'export function parseLine(line: string): { key: string; value: string } {\\n    const i = line.indexOf("=")\\n    return { key: line.slice(0, i).trim(), value: line.slice(i + 1).trim() }\\n}\\n')`) }),
            // Known-bad: refuses, so `resolved` must be false.
            Mock({ fix: "I can't do that" }),
        ],
    },

    // Real models are stochastic; one sample per cell is an anecdote.
    trials: 3,
})
