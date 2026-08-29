/**
 * The prepare demos.
 *
 * The default case is the one that matters and the one that is hardest to get
 * right: a prepare where nothing needed doing. It should be over almost before
 * it is seen, and leave a single line behind.
 */

import { Live } from "../live/index.ts"
import { prepare, PREPARE_STEPS, type PrepareWarning, type PrepareOpts } from "./prepare.ts"
import type { Result, Step } from "../components/index.ts"
import type { RendererHandle } from "../core/index.ts"
import type { AxonErrorLike } from "@arcforge/err"

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

type State = {
    steps?: Step[]
    modules?: Result[]
    result?: NonNullable<PrepareOpts["result"]>
    failure?: { error: AxonErrorLike; hint?: string }
}

export async function prepareDemo(r: RendererHandle, which = "default"): Promise<void> {
    const started = performance.now()
    const frozen = which === "frozen" || which === "drift"

    const live = Live<State>({
        renderer: r,
        view: (r, state, frame) => prepare(r, {
            project: "zeno",
            frozen,
            frame,
            ...(state.steps ? { steps: state.steps } : {}),
            ...(state.modules ? { modules: state.modules } : {}),
            ...(state.result ? { result: state.result } : {}),
            ...(state.failure ? { failure: state.failure } : {}),
        }),
        initial: { steps: PREPARE_STEPS.map(label => ({ label, state: "waiting" })) },
    })

    // Phases run fast when there is nothing to do — which is the point, and why
    // the finished view collapses rather than leaving five ✓ rows behind.
    const timings = which === "work"
        ? { Framework: 200, Modules: 1800, Cognet: 600, Tree: 300, Types: 900 }
        : { Framework: 90, Modules: 140, Cognet: 80, Tree: 90, Types: 160 }

    for (const label of PREPARE_STEPS) {
        const ms = timings[label]
        const begin = performance.now()
        live.update(s => ({ ...s, steps: patch(s.steps ?? [], label, { state: "active", ms: 0 }) }))
        while (performance.now() - begin < ms) {
            await sleep(60)
            live.update(s => ({
                ...s,
                steps: patch(s.steps ?? [], label, { ms: performance.now() - begin }),
            }))
        }
        live.update(s => ({ ...s, steps: patch(s.steps ?? [], label, { state: "done", ms }) }))
    }

    if (which === "drift") {
        live.stop({
            failure: {
                error: {
                    code: "AX-PROJECT-014",
                    title: "Dependencies Drifted From The Lockfile",
                    description:
                        "`--frozen` asserts that package.json, the lockfile and node_modules already agree. Something did not: a dependency is missing, at a version outside its declared range, or declared but no longer selected.",
                    message: "@cody/obsidian is declared at ^0.4.0 but 0.3.1 is installed",
                    severity: "fatal",
                    source: "manifest",
                    context: { pruned: "none", faults: 1 },
                    frames: [],
                    expected: true,
                },
                hint: "axon prepare",
            },
        })
        return
    }

    if (which === "warnings") {
        live.stop({
            result: {
                unchanged: true,
                warnings: [
                    { domain: "tools", message: "`search` is declared twice — the module's copy shadows yours" },
                    { domain: "models", message: "`hf:owner/repo` names a repo, not a weight file" },
                ],
                ms: performance.now() - started,
            },
        })
        return
    }

    if (which === "work") {
        live.stop({
            modules: [
                { name: "@cody/obsidian", outcome: "ok", detail: "0.4.2", note: "installed" },
                { name: "@axon/github", outcome: "noop", detail: "1.1.0", note: "cached" },
            ],
            result: { ms: performance.now() - started },
        })
        return
    }

    // The common case: everything was already in place.
    live.stop({ result: { unchanged: true, ms: performance.now() - started } })
}

function patch(steps: Step[], label: string, fields: Partial<Step>): Step[] {
    return steps.map(step => (step.label === label ? { ...step, ...fields } : step))
}
