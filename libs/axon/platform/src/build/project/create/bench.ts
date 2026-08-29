import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { err } from "@arcforge/err"
import { fsx } from "../../../utils/fs"
import { bareName, type ScaffoldOpts } from "../kinds"

const config = () => `/**
 * What this benchmark measures.
 *
 * A TypeScript type, not a config block: a doc comment is where a description
 * naturally lives, and a union is how you write a fixed set of categories.
 * \`axon bench prepare\` extracts this into .bench/schema.json so the manifest
 * carries the schema as a value — coverage can only report "expected 2,
 * observed 1" if it knows about measurements that never fired.
 */
type Schema = {
    /** Whether the task completed successfully. */
    success: boolean
}

export default defineBench<Schema>({
    // The agent's world. Copied fresh per iteration, so every run starts from
    // an identical workspace/ — nothing outside it is visible to the agent.
    workspace: { source: "./workspace", retain: "failed" },

    // Each key is an axis of variation; multiple keys multiply into a grid.
    // Start with one: changing a single variable is what makes a result
    // attributable to that variable.
    matrix: {
        // model: [OpenRouter({ model: "anthropic/claude-sonnet-4.6" })],
    },

    // Repetitions per test x cell. Models are stochastic — one sample is an
    // anecdote, not a measurement.
    trials: 1,
})
`

const test = `import { expect, it } from "bun:test"

it("completes the example task", async () => {
    // expect() is for the harness: if the world is not what the scenario
    // assumes, this trial measures nothing and should stop.
    expect(true).toBe(true)

    // observe() is for the subject: recorded whatever the value is. A model
    // that scores badly is a finding, not a failing test.
    bench.observe("success", true)
})
`

const readme = (name: string) => `# ${name}

Describe the benchmark methodology and limitations.

- workspace/ — the agent's world, copied fresh per iteration
- fixtures/  — author-side inputs: agents under test, setup data, rubrics. Never visible to the workspace agent
- tests/     — the scenarios, and where measurements are recorded
`

/**
 * Scaffold a benchmark at <dir>/<name>/. Source only — the .bench/ frame is
 * prepare()'s, written from the config's axes after dependencies land.
 */
export async function scaffoldBench(opts: ScaffoldOpts): Promise<string> {
    const root = join(opts.dir, bareName(opts.name))
    if (fsx.exists(root)) throw err("PROJECT_EXISTS", { detail: `${root} already exists`, context: { root } })
    await Promise.all([
        mkdir(join(root, "tests"), { recursive: true }),
        mkdir(join(root, "fixtures"), { recursive: true }),
        mkdir(join(root, "workspace"), { recursive: true }),
    ])
    await Promise.all([
        writeFile(join(root, "bench.config.ts"), config()),
        writeFile(join(root, "tests", "example.bench.ts"), test),
        writeFile(join(root, "README.md"), readme(opts.name)),
        writeFile(join(root, "package.json"), JSON.stringify({ name: opts.name, version: "0.1.0", private: false, type: "module" }, null, 2) + "\n"),
        writeFile(join(root, ".gitignore"), ".bench/runs/\n.bench/workspace/\n"),
    ])
    return root
}
