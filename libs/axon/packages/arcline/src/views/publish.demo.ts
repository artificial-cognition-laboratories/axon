/**
 * The publish demo the gallery plays.
 *
 * Scripted against the SAME `PublishStep` union the platform emits, driving
 * the same `Live` + `publish` view a real `axon publish` will — only the timing
 * is fake. So watching `arcline publish` is watching the real interaction, and
 * a step that reads badly here reads badly in production.
 *
 * Two demos, because they are two different claims about the surface.
 * `publishDemo` is the ordinary path — what a publish looks like almost every
 * time. `publishRetryDemo` is the version collision, which sends the flow
 * BACKWARDS through steps it already completed; it is hard to get right in a
 * display and impossible to trigger on demand, so a demo is the only place it
 * can be judged. They are separate so the common case is not represented by
 * the exception.
 */

import { Live } from "../live/index.ts"
import { publish, PUBLISH_STEPS, type PublishOpts } from "./publish.ts"
import type { Step } from "../components/index.ts"
import { failures, FAILURE_STEP_ORDER, type Failure } from "./publish.failures.ts"
import type { RendererHandle } from "../core/index.ts"

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/**
 * Derived from the view's own opts rather than restated.
 *
 * A hand-written copy is a second place for the result shape to live, and it
 * drifted the moment the view gained an assets report — the demo would not
 * compile against its own view.
 */
type State = {
    steps: Step[]
    result?: NonNullable<PublishOpts["result"]>
    failure?: { error: Failure["error"]; hint?: string }
}

/** The live surface both demos drive, plus the verb that plays one step. */
function surface(r: RendererHandle) {
    const live = Live<State>({
        renderer: r,
        view: (r, state, frame) => publish(r, {
            name: "@cody/zeno",
            steps: state.steps,
            frame,
            ...(state.result ? { result: state.result } : {}),
            ...(state.failure ? { failure: state.failure } : {}),
        }),
        initial: { steps: PUBLISH_STEPS.map(label => ({ label, state: "waiting" })) },
    })

    /**
     * Mark one step active, wait, then close it.
     *
     * TWO state updates for the whole step, which is what a real caller does —
     * one per phase the platform reports. The row's timer still counts up,
     * because `since` is read at render time on every repaint rather than
     * pushed in. This used to tick `ms` by hand in a loop; the gallery is the
     * reference, so it should not demonstrate work callers do not need to do.
     */
    async function play(label: string, ms: number, detail?: string): Promise<void> {
        const begin = performance.now()
        live.update(s => ({
            ...s,
            steps: patch(s.steps, label, { state: "active", since: begin, ...(detail ? { detail } : {}) }),
        }))
        await sleep(ms)
        live.update(s => ({ ...s, steps: patch(s.steps, label, { state: "done", ms, since: undefined }) }))
    }

    return { live, play }
}

/** The ordinary path — no collision, four steps, forward only. */
export async function publishDemo(r: RendererHandle): Promise<void> {
    const started = performance.now()
    const { live, play } = surface(r)

    await play("Bundling", 620)
    await play("Verifying", 1100)
    await play("Registering", 240)
    await play("Uploading", 1900, "v0.3.1")

    live.stop({
        steps: live.state.steps,
        result: {
            version: "0.3.1",
            visibility: "public",
            registeredId: "art_2c9f1ab4",
            assets: [
                { path: "assets/hero.png", size: "212 KB", from: "1.4 MB" },
                { path: "assets/demo.mp4", size: "3.1 MB" },
            ],
            ms: performance.now() - started,
        },
    })
}

/**
 * The version collision.
 *
 * A published version is immutable, so the backend rejects a repeat and the
 * flow bumps the patch, rebuilds, re-verifies and uploads again. Steps that
 * already completed re-open — the display must not pretend progress is
 * forward-only, and the bump announces the version it moved to because that
 * number is not the one the author typed.
 */
export async function publishRetryDemo(r: RendererHandle): Promise<void> {
    const started = performance.now()
    const { live, play } = surface(r)

    await play("Bundling", 620)
    await play("Verifying", 1100)
    await play("Registering", 240)
    await play("Uploading", 900, "v0.3.0")

    live.update(s => ({
        ...s,
        steps: patch(s.steps, "Uploading", { state: "waiting", detail: "v0.3.0 exists — bumped to v0.3.1" }),
    }))
    await sleep(600)

    await play("Bundling", 380, "rebuild")
    await play("Verifying", 700)
    await play("Uploading", 1600, "v0.3.1")

    live.stop({
        steps: live.state.steps,
        result: {
            version: "0.3.1",
            visibility: "public",
            registeredId: "art_2c9f1ab4",
            assets: [
                { path: "assets/hero.png", size: "212 KB", from: "1.4 MB" },
                { path: "assets/demo.mp4", size: "3.1 MB" },
            ],
            ms: performance.now() - started,
        },
    })
}

/** Replace one step's fields by label, leaving the rest untouched. */
function patch(steps: Step[], label: string, fields: Partial<Step>): Step[] {
    return steps.map(step => (step.label === label ? { ...step, ...fields } : step))
}

/**
 * A publish that fails. Plays forward normally up to the failing step, then
 * dies there — the run-up matters, because a failure the user watched arrive
 * reads differently from one printed cold.
 */
export async function publishFailDemo(r: RendererHandle, which: string): Promise<void> {
    const failure = failures[which]
    if (!failure) {
        throw new Error(`unknown --fail value "${which}" — try ${Object.keys(failures).join(", ")}`)
    }

    const { live, play } = surface(r)
    const index = FAILURE_STEP_ORDER.indexOf(failure.failedAt)

    for (const label of FAILURE_STEP_ORDER.slice(0, index)) {
        await play(label, 500)
    }

    // The failing step runs before it dies — a step that fails instantly looks
    // like it was never attempted.
    const dying = FAILURE_STEP_ORDER[index]!
    live.update(s => ({ ...s, steps: patch(s.steps, dying, { state: "active", since: performance.now() }) }))
    await sleep(900)

    live.stop({
        steps: patch(live.state.steps, dying, { state: "failed", ms: 900, since: undefined }),
        failure: { error: failure.error, ...(failure.hint ? { hint: failure.hint } : {}) },
    })
}
