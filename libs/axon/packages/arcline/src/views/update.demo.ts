/**
 * The update demos.
 *
 * Four outcomes, and the three that are not "it worked" are the reason this
 * view exists: a rollback leaves a WORKING machine, a failed rollback does
 * not, and those must not look the same.
 */

import { Live } from "../live/index.ts"
import { update, UPDATE_STEPS, type UpdateOpts } from "./update.ts"
import type { Step } from "../components/index.ts"
import type { RendererHandle } from "../core/index.ts"

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

type State = {
    steps: Step[]
    result?: NonNullable<UpdateOpts["result"]>
}

const FROM = "2.0.158"
const TO = "2.0.159"

export async function updateDemo(r: RendererHandle, which = "default"): Promise<void> {
    // Nothing to install, so nothing to narrate — no live surface at all.
    if (which === "current") {
        r.line(update(r, { from: TO, to: TO, steps: [], result: { outcome: "current" } }))
        return
    }

    const started = performance.now()

    const live = Live<State>({
        renderer: r,
        view: (r, state, frame) => update(r, {
            from: FROM,
            to: TO,
            steps: state.steps,
            frame,
            ...(state.result ? { result: state.result } : {}),
        }),
        initial: { steps: UPDATE_STEPS.map(label => ({ label, state: "waiting" })) },
    })

    const patch = (steps: Step[], label: string, fields: Partial<Step>): Step[] =>
        steps.map(step => (step.label === label ? { ...step, ...fields } : step))

    async function play(label: string, ms: number, detail?: string): Promise<void> {
        const begin = performance.now()
        live.update(s => ({
            ...s,
            steps: patch(s.steps, label, { state: "active", since: begin, ...(detail ? { detail } : {}) }),
        }))
        await sleep(ms)
        live.update(s => ({ ...s, steps: patch(s.steps, label, { state: "done", ms, since: undefined }) }))
    }

    // A just-published version takes time to reach every npm edge, so the
    // installer retries with backoff. Shown, because a silent multi-second
    // wait looks like a hang against a registry doing exactly what it should.
    if (which === "retry") {
        const begin = performance.now()
        live.update(s => ({
            ...s,
            steps: patch(s.steps, "Installing", { state: "active", since: begin, detail: `${FROM} → ${TO}` }),
        }))
        await sleep(900)
        live.update(s => ({
            ...s,
            steps: patch(s.steps, "Installing", { detail: "not on this npm edge yet — retrying in 2s" }),
        }))
        await sleep(1400)
        live.update(s => ({
            ...s,
            steps: patch(s.steps, "Installing", { state: "done", ms: 2300, since: undefined, detail: `${FROM} → ${TO}` }),
        }))
    } else {
        await play("Installing", 1800, `${FROM} → ${TO}`)
    }

    if (which === "rollback" || which === "failed") {
        const begin = performance.now()
        live.update(s => ({ ...s, steps: patch(s.steps, "Verifying", { state: "active", since: begin }) }))
        await sleep(700)

        live.stop({
            steps: patch(live.state.steps, "Verifying", { state: "failed", ms: 700, since: undefined }),
            result: which === "rollback"
                ? { outcome: "rolled-back", ms: performance.now() - started }
                : {
                    outcome: "failed",
                    ms: performance.now() - started,
                    recovery: "curl -fsSL https://axon.arclabs.it/install | bash",
                },
        })
        return
    }

    await play("Verifying", 500)
    live.stop({
        steps: live.state.steps,
        result: { outcome: "installed", ms: performance.now() - started },
    })
}
