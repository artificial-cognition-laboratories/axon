/**
 * The clone demos.
 *
 * The download shows a real bar because it is the one step in the product with
 * a genuine denominator. Note the platform does not supply one yet — download()
 * buffers with arrayBuffer() — so this demonstrates the view's capability and
 * the shape the platform change would take, not something already wired.
 */

import { Live } from "../live/index.ts"
import { clone, bytes, CLONE_STEPS, type CloneOpts } from "./clone.ts"
import type { Step, TreeNode } from "../components/index.ts"
import type { RendererHandle } from "../core/index.ts"
import type { AxonErrorLike } from "@arcforge/err"

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

type State = {
    steps: Step[]
    result?: NonNullable<CloneOpts["result"]>
    failure?: { error: AxonErrorLike; hint?: string }
}

const MODULE_FILES: TreeNode[] = [
    { label: "src", children: [{ label: "index.ts" }, { label: "vault.ts" }] },
    { label: "module.config.ts" },
    { label: "package.json" },
    { label: "README.md" },
]

const TOTAL_BYTES = 254_000

export async function cloneDemo(r: RendererHandle, which = "default"): Promise<void> {
    const started = performance.now()
    const as = which === "fork" ? "@cody/obsidian" : undefined

    const live = Live<State>({
        renderer: r,
        view: (r, state, frame) => clone(r, {
            source: "@axon/obsidian",
            ...(as ? { as } : {}),
            steps: state.steps,
            frame,
            ...(state.result ? { result: state.result } : {}),
            ...(state.failure ? { failure: state.failure } : {}),
        }),
        initial: { steps: CLONE_STEPS.map(label => ({ label, state: "waiting" })) },
    })

    async function play(label: string, ms: number, detail?: string): Promise<void> {
        const begin = performance.now()
        live.update(s => ({
            ...s,
            steps: patch(s.steps, label, { state: "active", ms: 0, ...(detail ? { detail } : {}) }),
        }))
        while (performance.now() - begin < ms) {
            await sleep(70)
            live.update(s => ({ ...s, steps: patch(s.steps, label, { ms: performance.now() - begin }) }))
        }
        live.update(s => ({ ...s, steps: patch(s.steps, label, { state: "done", ms }) }))
    }

    if (which === "not-found") {
        const begin = performance.now()
        live.update(s => ({ ...s, steps: patch(s.steps, "Resolving", { state: "active", ms: 0 }) }))
        while (performance.now() - begin < 800) {
            await sleep(70)
            live.update(s => ({ ...s, steps: patch(s.steps, "Resolving", { ms: performance.now() - begin }) }))
        }
        live.stop({
            steps: patch(live.state.steps, "Resolving", { state: "failed", ms: 800 }),
            failure: {
                error: {
                    code: "AX-PROJECT-009",
                    title: "Artifact Not Found",
                    description: "No published artifact matches that name. Check the spelling, or search the registry for what does exist.",
                    message: "@axon/obsidain is not in the registry",
                    severity: "fatal",
                    source: "cloud",
                    context: { name: "@axon/obsidain" },
                    frames: [],
                    expected: true,
                },
                hint: "axon search obsidian",
            },
        })
        return
    }

    await play("Resolving", 500, "1.4.0")

    // The download, with a bar driven by bytes rather than by a timer.
    const downloadMs = 1400
    const begin = performance.now()
    while (performance.now() - begin < downloadMs) {
        await sleep(70)
        const elapsed = performance.now() - begin
        const fraction = Math.min(1, elapsed / downloadMs)
        live.update(s => ({
            ...s,
            steps: patch(s.steps, "Downloading", {
                state: "active",
                ms: elapsed,
                progress: fraction,
                detail: `${bytes(Math.round(TOTAL_BYTES * fraction))} / ${bytes(TOTAL_BYTES)}`,
            }),
        }))
    }
    live.update(s => ({
        ...s,
        steps: patch(s.steps, "Downloading", {
            state: "done",
            ms: downloadMs,
            progress: undefined,
            detail: bytes(TOTAL_BYTES),
        }),
    }))

    await play("Extracting", 300)
    await play("Preparing", 1600)

    const directory = (as ?? "@axon/obsidian").split("/").pop()!
    live.stop({
        steps: live.state.steps,
        result: {
            version: as ? "0.1.0" : "1.4.0",
            root: `./${directory}`,
            files: MODULE_FILES,
            next: `cd ${directory} && axon dev`,
            ms: performance.now() - started,
        },
    })
}

function patch(steps: Step[], label: string, fields: Partial<Step>): Step[] {
    return steps.map(step => (step.label === label ? { ...step, ...fields } : step))
}
