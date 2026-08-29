/**
 * The deploy demos.
 *
 * Timings are compressed — a real `Starting` can run ninety seconds and nobody
 * will watch that in a gallery — but the SHAPE is real: the wait reports the
 * deployment's own phase as the control plane hands it over, which is the part
 * that has to be judged rather than described.
 */

import { Live } from "../live/index.ts"
import { deploy, DEPLOY_STEPS, type DeployOpts } from "./deploy.ts"
import type { Step, LogLine } from "../components/index.ts"
import type { RendererHandle } from "../core/index.ts"
import type { AxonErrorLike } from "@arcforge/err"

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

type State = {
    steps: Step[]
    result?: NonNullable<DeployOpts["result"]>
    failure?: { error: AxonErrorLike; hint?: string; output?: LogLine[] }
}

const PLAN = { tier: "small", warmth: "on-demand", cost: "~$10/mo" }

function surface(r: RendererHandle) {
    const live = Live<State>({
        renderer: r,
        view: (r, state, frame) => deploy(r, {
            name: "@cody/zeno",
            plan: PLAN,
            steps: state.steps,
            frame,
            ...(state.result ? { result: state.result } : {}),
            ...(state.failure ? { failure: state.failure } : {}),
        }),
        initial: { steps: DEPLOY_STEPS.map(label => ({ label, state: "waiting" })) },
    })

    /**
     * Run one step for `ms`, ticking its elapsed clock.
     *
     * `phases` lets a long step report what it is doing as it goes — the
     * control plane's own status, shown on the row rather than hidden behind a
     * spinner. Each phase gets an equal slice of the duration.
     */
    async function play(label: string, ms: number, phases?: string[]): Promise<void> {
        const begin = performance.now()
        live.update(s => ({ ...s, steps: patch(s.steps, label, { state: "active", ms: 0 }) }))

        while (performance.now() - begin < ms) {
            await sleep(80)
            const elapsed = performance.now() - begin
            const detail = phases?.[Math.min(phases.length - 1, Math.floor((elapsed / ms) * phases.length))]
            live.update(s => ({
                ...s,
                steps: patch(s.steps, label, { ms: elapsed, ...(detail ? { detail } : {}) }),
            }))
        }

        live.update(s => ({ ...s, steps: patch(s.steps, label, { state: "done", ms, detail: undefined }) }))
    }

    return { live, play }
}

/** The ordinary path — ends somewhere you can go. */
export async function deployDemo(r: RendererHandle): Promise<void> {
    const started = performance.now()
    const { live, play } = surface(r)

    await play("Bundling", 700)
    await play("Registering", 400)
    await play("Publishing", 1600)
    await play("Provisioning", 2400, ["requesting capacity", "allocating", "attaching disk"])
    // The long one. Phases are what the deployment's own status reports, so a
    // user watching for a minute can tell healthy-but-slow from wedged.
    await play("Starting", 3600, ["container starting", "booting runtime", "waiting for health check"])

    live.stop({
        steps: live.state.steps,
        result: {
            url: "https://zeno-cody.axon.run",
            facts: [
                ["Deployment", "dep_8f2a41c9"],
                ["Tier", PLAN.tier],
                ["Region", "europe-west3"],
            ],
            ms: performance.now() - started,
        },
    })
}

/**
 * The container came up and died. The most important failure in the product:
 * the infrastructure is fine, the user's own agent threw at boot, and the
 * answer is in the container's output rather than in anything we can say.
 */
export async function deployFailDemo(r: RendererHandle, which: string): Promise<void> {
    const failure = deployFailures[which]
    if (!failure) {
        throw new Error(`unknown --fail value "${which}" — try ${Object.keys(deployFailures).join(", ")}`)
    }

    const { live, play } = surface(r)
    const index = DEPLOY_STEPS.indexOf(failure.failedAt)

    for (const label of DEPLOY_STEPS.slice(0, index)) {
        await play(label, 600)
    }

    const dying = DEPLOY_STEPS[index]!
    const begin = performance.now()
    live.update(s => ({ ...s, steps: patch(s.steps, dying, { state: "active", ms: 0 }) }))
    while (performance.now() - begin < 2200) {
        await sleep(80)
        const elapsed = performance.now() - begin
        const detail = failure.phases?.[
            Math.min(failure.phases.length - 1, Math.floor((elapsed / 2200) * failure.phases.length))
        ]
        live.update(s => ({
            ...s,
            steps: patch(s.steps, dying, { ms: elapsed, ...(detail ? { detail } : {}) }),
        }))
    }

    live.stop({
        steps: patch(live.state.steps, dying, { state: "failed", ms: 2200, detail: undefined }),
        failure: {
            error: failure.error,
            ...(failure.hint ? { hint: failure.hint } : {}),
            ...(failure.output ? { output: failure.output } : {}),
        },
    })
}

type DeployFailure = {
    failedAt: (typeof DEPLOY_STEPS)[number]
    error: AxonErrorLike
    hint?: string
    output?: LogLine[]
    phases?: string[]
}

/**
 * Real codes from `@arcforge/err`'s map, with that entry's own prose.
 *
 * `runtime` is the one that matters most — it is the failure a user causes and
 * can fix, and the only evidence is the container's own output.
 */
export const deployFailures: Record<string, DeployFailure> = {
    runtime: {
        failedAt: "Starting",
        phases: ["container starting", "booting runtime"],
        hint: "axon logs --deployment dep_8f2a41c9",
        error: {
            code: "AX-PROJECT-035",
            title: "Agent Failed To Start",
            description:
                "Cloud infrastructure was provisioned, but the agent process failed during boot. The reported runtime diagnostic identifies the immediate cause.",
            message: "RevisionFailed: the container exited before becoming healthy",
            severity: "fatal",
            source: "runtime",
            context: { reason: "RevisionFailed", deploymentId: "dep_8f2a41c9" },
            frames: [],
            expected: true,
        },
        output: [
            { severity: "INFO", message: "starting axon runtime v2.0.158" },
            { severity: "INFO", message: "loading cognet @axon/astra-v1" },
            { severity: "INFO", message: "loading module @cody/obsidian" },
            { severity: "ERROR", message: "Cannot find module 'node:sqlite'" },
            { severity: "ERROR", message: "    at file:///app/modules/obsidian/index.js:3:22" },
            { severity: "ERROR", message: "    at ModuleLoader.load (node:internal/modules/esm/loader:412:9)" },
            { severity: "INFO", message: "runtime exited with code 1" },
        ],
    },

    /** The control plane itself failed. Ours to fix, so it carries a request ID. */
    provision: {
        failedAt: "Provisioning",
        phases: ["requesting capacity"],
        hint: "retry, and quote request ID req_4c81ff20 if it persists",
        error: {
            code: "AX-PROJECT-012",
            title: "Deployment Provisioning Failed",
            description:
                "The agent was published, but the cloud control plane could not provision its runtime. The request ID identifies the server-side failure.",
            message: "Cloud request failed with status 503 (request ID: req_4c81ff20)",
            severity: "fatal",
            source: "manifest",
            context: { status: 503, path: "/api/user/deployments", requestId: "req_4c81ff20" },
            frames: [
                {
                    functionName: "provision",
                    fileName: "libs/cloud/src/registry/agents/agents.ts",
                    lineNumber: 77,
                    columnNumber: 30,
                    source: null,
                },
            ],
            cause: new Error("HTTP 503 Service Unavailable"),
        },
    },

    /** Refused before anything was provisioned — the balance cannot cover it. */
    funds: {
        failedAt: "Provisioning",
        hint: "top up at https://axon.arclabs.it/billing",
        error: {
            code: "AX-PROJECT-012",
            title: "Insufficient Funds",
            description:
                "Provisioning was rejected because the balance cannot cover this deployment's monthly commitment. Nothing was provisioned and nothing has been charged.",
            message: "requires $10.00, available $2.40",
            severity: "fatal",
            source: "cloud",
            context: { required: "$10.00", available: "$2.40", deficit: "$7.60" },
            frames: [],
            expected: true,
        },
    },
}

function patch(steps: Step[], label: string, fields: Partial<Step>): Step[] {
    return steps.map(step => (step.label === label ? { ...step, ...fields } : step))
}
