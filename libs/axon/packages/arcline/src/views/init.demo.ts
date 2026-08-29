/**
 * The init demos.
 *
 * `--ask` plays the missing-name path: `axon init` with no argument prompts
 * rather than failing with a usage error, since this is the first command a
 * new user runs and a usage error is a bad first five seconds.
 */

import { Live, text } from "../live/index.ts"
import { init, INIT_STEPS, type InitOpts } from "./init.ts"
import type { Step, TreeNode } from "../components/index.ts"
import type { RendererHandle } from "../core/index.ts"
import type { AxonErrorLike } from "@arcforge/err"

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

type State = {
    steps: Step[]
    result?: NonNullable<InitOpts["result"]>
    failure?: { error: AxonErrorLike; hint?: string }
}

/**
 * What `scaffoldAgent` writes — see platform's create/agent.ts.
 *
 * `.gitignore` is written too but deliberately not listed: dotfiles are
 * plumbing the user did not ask for and will not edit, and showing them
 * pushes the files that DO matter further down the list. Filtered here rather
 * than in the tree component, which must render exactly what it is given.
 */
const AGENT_FILES: TreeNode[] = [
    { label: "axon.config.ts" },
    { label: "package.json" },
    { label: "bunfig.toml" },
    { label: "src", children: [{ label: "boot.vue" }] },
]

function surface(r: RendererHandle, kind: string, name: string) {
    const live = Live<State>({
        renderer: r,
        view: (r, state, frame) => init(r, {
            kind,
            name,
            steps: state.steps,
            frame,
            ...(state.result ? { result: state.result } : {}),
            ...(state.failure ? { failure: state.failure } : {}),
        }),
        initial: { steps: INIT_STEPS.map(label => ({ label, state: "waiting" })) },
    })

    async function play(label: string, ms: number, detail?: string): Promise<void> {
        const begin = performance.now()
        live.update(s => ({
            ...s,
            steps: patch(s.steps, label, { state: "active", ms: 0, ...(detail ? { detail } : {}) }),
        }))

        while (performance.now() - begin < ms) {
            await sleep(80)
            const elapsed = performance.now() - begin
            live.update(s => ({ ...s, steps: patch(s.steps, label, { ms: elapsed }) }))
        }

        live.update(s => ({ ...s, steps: patch(s.steps, label, { state: "done", ms }) }))
    }

    return { live, play }
}

export async function initDemo(r: RendererHandle, opts: { ask?: boolean } = {}): Promise<void> {
    // The prompt comes BEFORE the surface: a name is needed to render the
    // header, and asking underneath a half-drawn view would mean two things
    // owning the cursor at once.
    const name = opts.ask
        ? await text(r, {
              label: "Name",
              defaultValue: "zeno",
              hint: "used for the directory and the registry name",
              validate: value =>
                  /^[a-z0-9-]+$/.test(value.trim())
                      ? undefined
                      : "lowercase letters, numbers and dashes only",
          })
        : "zeno"

    const started = performance.now()
    const { live, play } = surface(r, "agent", name)

    await play("Scaffolding", 400)
    await play("Installing", 2600, "@arcforge/types, @arcforge/engines")
    await play("Generating", 900)

    live.stop({
        steps: live.state.steps,
        result: {
            files: AGENT_FILES,
            root: `./${name}`,
            next: `cd ${name} && axon dev`,
            ms: performance.now() - started,
        },
    })
}

function patch(steps: Step[], label: string, fields: Partial<Step>): Step[] {
    return steps.map(step => (step.label === label ? { ...step, ...fields } : step))
}
