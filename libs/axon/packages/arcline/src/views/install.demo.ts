/**
 * The install demos.
 *
 * Modules resolve one at a time so the batch fills in visibly — a real install
 * hits the registry per specifier, and a list that appears fully-formed would
 * hide which one is slow.
 */

import { Live } from "../live/index.ts"
import { install, type InstallOpts } from "./install.ts"
import type { Result, Step } from "../components/index.ts"
import type { RendererHandle } from "../core/index.ts"

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

type State = {
    modules: Result[]
    prepare?: Step
    result?: NonNullable<InstallOpts["result"]>
}

/** The batches each demo plays, as (name, outcome) once resolved. */
const BATCHES: Record<string, Result[]> = {
    /** The ordinary case: some new, one already there. */
    default: [
        { name: "@cody/obsidian", outcome: "ok", detail: "0.4.2", note: "installed" },
        { name: "@axon/github", outcome: "ok", detail: "1.1.0", note: "installed" },
        { name: "@cody/notion", outcome: "noop", detail: "0.2.0", note: "already installed" },
    ],

    /**
     * A typo among good names — the case the old command handled worst: it
     * threw on this row and reported nothing about the two that landed.
     */
    "not-found": [
        { name: "@cody/obsidian", outcome: "ok", detail: "0.4.2", note: "installed" },
        { name: "@axon/github", outcome: "ok", detail: "1.1.0", note: "installed" },
        { name: "@cody/typoo", outcome: "fail", note: "not found in the registry" },
    ],

    /** Everything already present. The summary must not claim work was done. */
    noop: [
        { name: "@cody/obsidian", outcome: "noop", detail: "0.4.2", note: "already installed" },
        { name: "@axon/github", outcome: "noop", detail: "1.1.0", note: "already installed" },
    ],

    /** A real fault rather than a missing name. */
    error: [
        { name: "@cody/obsidian", outcome: "ok", detail: "0.4.2", note: "installed" },
        { name: "@axon/private", outcome: "fail", note: "403 — not authorized for this scope" },
    ],
}

export async function installDemo(r: RendererHandle, which = "default"): Promise<void> {
    const batch = BATCHES[which]
    if (!batch) {
        throw new Error(`unknown --case value "${which}" — try ${Object.keys(BATCHES).join(", ")}`)
    }

    const started = performance.now()

    const live = Live<State>({
        renderer: r,
        view: (r, state, frame) => install(r, {
            agent: "@cody/zeno",
            modules: state.modules,
            frame,
            ...(state.prepare ? { prepare: state.prepare } : {}),
            ...(state.result ? { result: state.result } : {}),
        }),
        // Every requested module is listed from the start, waiting. A user who
        // typed four names should see four rows immediately — appearing one by
        // one would make a slow registry look like a lost argument.
        initial: { modules: batch.map(m => ({ name: m.name, outcome: "waiting" as const })) },
    })

    for (const [index, resolved] of batch.entries()) {
        live.update(s => ({ ...s, modules: replace(s.modules, index, { ...resolved, outcome: "active" }) }))
        await sleep(resolved.outcome === "noop" ? 260 : 700)
        live.update(s => ({ ...s, modules: replace(s.modules, index, resolved) }))
    }

    const failed = batch.some(m => m.outcome === "fail")

    // Types are regenerated only if something actually landed. Running typegen
    // after a batch that installed nothing is work with no input, and after a
    // failed one it would bless a half-applied state.
    if (!failed && batch.some(m => m.outcome === "ok")) {
        live.update(s => ({ ...s, prepare: { label: "Generating types", state: "active", ms: 0 } }))
        const begin = performance.now()
        while (performance.now() - begin < 900) {
            await sleep(80)
            live.update(s => ({
                ...s,
                prepare: { label: "Generating types", state: "active", ms: performance.now() - begin },
            }))
        }
        live.update(s => ({ ...s, prepare: { label: "Generating types", state: "done", ms: 900 } }))
    }

    live.stop({
        modules: live.state.modules,
        ...(live.state.prepare ? { prepare: live.state.prepare } : {}),
        result: {
            ms: performance.now() - started,
            // Only a FAILED batch gets a next step. Install is a mid-workflow
            // command — whoever ran it is already in a project and very likely
            // has `axon dev` running in another pane, so telling them to start
            // it is noise. A failure is different: the batch did not do what
            // was asked, and the way out is not on screen otherwise.
            ...(failed ? { next: "check the name at axon.arclabs.it" } : {}),
        },
    })
}

function replace(items: Result[], index: number, value: Result): Result[] {
    return items.map((item, i) => (i === index ? value : item))
}
