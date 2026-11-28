import { header, rows, status } from "@arcforge/arcline"
import { err } from "@arcforge/err"
import { LAB_IDS, type LabId, type Lease, type ScenarioRun } from "../../labs/index"
import type { CliContext } from "./types"

/** How often a run under way is read while a person watches it. */
const FOLLOW_MS = 1_000

/**
 * WorldCommands owns `axon world`: every lab's worlds, what is running in
 * each, and the scenarios set up in them.
 *
 * It LISTS. Putting an agent into a world is `axon <ref> -c <address>`, which
 * says where in one string and owns the run; this is what you read to find
 * out what to type there. The two used to be one command, with `--agent`
 * pointing the other way round.
 *
 * Every lab, not one: this asked `client.labs.minecraft` by name for every
 * verb, so Atrium's worlds and Terraria's were invisible to the command whose
 * whole job is saying what exists.
 */
export function WorldCommands(opts: CliContext) {
    const r = opts.renderer

type Survey = { lab: LabId; worlds: string[]; running: Set<string>; problem: string | null; failure: string | null }

    /**
     * One lab's worlds, and what is running among them.
     *
     * A lab that cannot be ASKED is reported as a failure against its own
     * name, not dropped: the other labs are still the answer to the question,
     * but "this lab did not answer" and "this lab has no worlds" are different
     * facts and a listing that cannot tell them apart is the one that says
     * "no labs are available" when the daemon is simply out of date.
     */
    async function surveyed(id: LabId): Promise<Survey> {
        try {
            const state = await opts.client.labs[id].state()
            return {
                lab: id,
                worlds: state.worlds.filter(world => world.source === "lab").map(world => world.name),
                running: new Set(state.running.map(world => world.name)),
                problem: state.problem,
                failure: null,
            }
        } catch (cause) {
            return { lab: id, worlds: [], running: new Set(), problem: null, failure: cause instanceof Error ? cause.message : String(cause) }
        }
    }

    /**
     * The lab and world an address-shaped argument names.
     *
     * `<lab>/<world>` is exact. A bare name is searched for across every lab
     * and must match exactly one: two labs with a world of the same name is
     * an ambiguity to say out loud, not one to resolve by preferring a lab.
     */
    async function resolve(said: string): Promise<{ lab: LabId; world: string }> {
        const parts = said.split("/")
        const surveys = await Promise.all(LAB_IDS.map(surveyed))
        if (parts.length === 2) {
            const lab = LAB_IDS.find(id => id === parts[0])
            if (!lab) throw err("WORLD_NOT_FOUND", { detail: `${parts[0]} is not a lab — there are ${LAB_IDS.join(", ")}` })
            const survey = surveys.find(found => found.lab === lab)
            if (!survey) throw new Error(`${lab} was not surveyed`)
            if (survey.failure !== null) throw err("WORLD_NOT_FOUND", { detail: `${lab} did not answer: ${survey.failure}` })
            if (!survey.worlds.includes(parts[1]!)) {
                // World names are exact — a folder on disk — so a near miss is named, not taken.
                const near = survey.worlds.find(world => world.toLowerCase() === parts[1]!.toLowerCase())
                throw err("WORLD_NOT_FOUND", { detail: near
                    ? `${lab} has no world ${parts[1]} — did you mean ${near}? world://localhost/${lab}/${encodeURIComponent(near)}`
                    : `${lab} has no world ${parts[1]} — it has ${survey.worlds.join(", ") || "none"}` })
            }
            return { lab: lab, world: parts[1]! }
        }
        const unanswered = surveys.filter(survey => survey.failure !== null)
        const found = surveys.flatMap(survey => survey.worlds.filter(world => world === said).map(world => ({ lab: survey.lab, world: world })))
        if (found.length === 1) return found[0]!
        if (found.length === 0) {
            // Never "no such world" when a lab could not be asked — that is
            // the shape of answer that sends someone looking in the wrong place.
            const silent = unanswered.length ? ` (${unanswered.map(survey => `${survey.lab} did not answer: ${survey.failure}`).join("; ")})` : ""
            throw err("WORLD_NOT_FOUND", { detail: `no lab has a world called ${said} — \`axon world\` lists them${silent}` })
        }
        throw err("WORLD_NOT_FOUND", { detail: `${found.map(hit => `${hit.lab}/${hit.world}`).join(" and ")} are both called ${said} — say which` })
    }

    return {
        /** Every lab's worlds, and which are running. */
        async worlds(json = false): Promise<string> {
            const surveys = await Promise.all(LAB_IDS.map(surveyed))
            if (json) return JSON.stringify({ labs: surveys.map(survey => ({ lab: survey.lab, worlds: survey.worlds, running: [...survey.running], problem: survey.problem, failure: survey.failure })) })

            const lines: string[] = []
            for (const survey of surveys) {
                lines.push(header(r, { title: survey.lab, subtitle: survey.problem ?? `${survey.worlds.length} worlds` }), "")
                lines.push(...(survey.failure
                    ? [status(r, "fail", "did not answer", survey.failure)]
                    : survey.worlds.length
                        ? rows(r, survey.worlds.map(world => ({
                            label: world,
                            value: survey.running.has(world) ? "running" : `world://localhost/${survey.lab}/${encodeURIComponent(world)}`,
                            arrow: false,
                        })))
                        : [status(r, "info", "no worlds", "import one from the lab's page in Axon Fleet")]))
                lines.push("")
            }
            lines.push("  put an agent in one:  axon <agent> -c world://localhost/<lab>/<world>")
            return lines.join("\n")
        },

        /** One world: where it is, whether it is running, and its scenarios. */
        async world(said: string, json = false): Promise<string> {
            const { lab, world } = await resolve(said)
            const state = await opts.client.labs[lab].state()
            const running = state.running.find(live => live.name === world) ?? null
            // A lab with no scenarios says so rather than reporting none, so
            // "this world has none" and "this lab cannot" stay distinguishable.
            const scenarios = await opts.client.labs[lab].scenarios({ world: world }).catch((cause: unknown) => (cause instanceof Error ? cause.message : String(cause)))
            const address = `world://localhost/${lab}/${encodeURIComponent(world)}`
            if (json) return JSON.stringify({ lab: lab, world: world, address: address, running: running, scenarios: scenarios })

            const facts = [
                { label: "lab", value: lab, arrow: false },
                { label: "address", value: address, arrow: false },
                { label: "running", value: running ? `${running.state} · ${running.host}:${running.port}` : "no", arrow: false },
            ]
            return [
                header(r, { title: world }),
                "",
                ...rows(r, facts),
                "",
                ...(Array.isArray(scenarios)
                    ? scenarios.length
                        ? [header(r, { title: "scenarios" }), "", ...rows(r, scenarios.map(scenario => ({ label: scenario, value: `${address}/${scenario}`, arrow: false })))]
                        : [status(r, "info", "no scenarios", "set one up in the world: /scenario new <name>")]
                    : [status(r, "info", "no scenarios here", scenarios)]),
            ].join("\n")
        },

        /**
         * That `lab` has a world called `world`, or a thrown reason it has not —
         * asked before an agent is booted toward it, so a wrong address fails
         * in a second with the answer rather than as a body that never comes.
         */
        async place(input: { lab: LabId; world: string }): Promise<void> {
            await resolve(`${input.lab}/${input.world}`)
        },

        /**
         * The world address of what a game's address names: `terra://localhost:52559`, the one a
         * Terraverse player joins by, as the lab world there. A world the lab serves on that port is
         * that one; any other (opened in the game, or `terra serve` in a terminal) is attached to,
         * so the agent goes into the world the player is in.
         */
        async at(said: string): Promise<string> {
            let url: URL
            try {
                url = new URL(said)
            } catch {
                throw err("WORLD_ADDRESS_INVALID", { detail: `${said} is not an address` })
            }
            if (url.protocol !== "terra:") throw err("WORLD_ADDRESS_INVALID", { detail: `${said} is not a game's address (terra://host:port)` })
            if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
                throw err("WORLD_ADDRESS_REMOTE", { detail: `${url.hostname} is not this machine, and a lab elsewhere is not wired yet` })
            const world = await opts.client.labs.terraverse.attach({ address: said })
            return `world://localhost/terraverse/${encodeURIComponent(world.name)}`
        },

        /** Puts `agent` through a scenario in a world; the run is the daemon's and carries on without this terminal. */
        runStart(input: { lab: LabId; world: string; scenario: string; agent: string }): Promise<ScenarioRun> {
            return opts.client.labs[input.lab].runs.start({ world: input.world, scenario: input.scenario, agent: input.agent })
        },

        runCancel(input: { lab: LabId; id: string }): Promise<void> {
            return opts.client.labs[input.lab].runs.cancel({ id: input.id })
        },

        /**
         * The lease `agent` holds in `world`, if it has one yet — how a caller
         * that started an agent finds out whether it actually got into the
         * world, rather than assuming that serving means embodied.
         *
         * By agent and world, not by process: the pid a lease carries is the
         * one the body module read inside the agent, which is not the pid its
         * supervisor holds for it.
         */
        async worn(input: { lab: LabId; agent: string; world: string | null }): Promise<Lease | null> {
            const state = await opts.client.labs[input.lab].state()
            return state.leases.find(held => held.agent === input.agent && (input.world === null || held.world === input.world)) ?? null
        },

        /** Reads a run until it ends, saying each step and each thing the world saw; then the summary. */
        async runFollow(lab: LabId, id: string, say: (line: string) => void): Promise<string> {
            let steps = 0
            let events = 0
            for (;;) {
                const run = await opts.client.labs[lab].runs.get({ id: id })
                for (const step of run.steps.slice(steps)) say(status(r, "pending", step.text))
                for (const event of run.events.slice(events)) say(status(r, "info", `world: ${event.kind}`, event.detail))
                steps = run.steps.length
                events = run.events.length
                if (run.endedAt) return summary(run)
                await Bun.sleep(FOLLOW_MS)
            }
        },
    }

    function summary(run: { id: string; scenario: string; world: string; agent: string; phase: string; outcome?: string | null; failure?: string | null; session?: string | null; agentRoot?: string | null; copy: string }): string {
        const ended = run.phase === "ended"
        const facts = [
            { label: "run", value: run.id, arrow: false },
            { label: "outcome", value: ended ? run.outcome ?? "—" : run.phase, arrow: false },
            { label: "session", value: run.session ?? "—", arrow: false },
            { label: "world after", value: run.copy, arrow: false },
        ]
        return [
            status(r, ended ? "ok" : run.phase === "cancelled" ? "warn" : "fail", `${run.scenario} in ${run.world} · ${run.agent}`, ended ? undefined : run.failure ?? run.phase),
            "",
            ...rows(r, facts),
            ...(run.session && run.agentRoot ? ["", `  inspect it: cd ${run.agentRoot} && axon debug session ${run.session}`] : []),
        ].join("\n")
    }
}
