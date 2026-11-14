import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { RepositoryJobs } from "../../src/jobs/repository"
import { Workspaces } from "../../src/jobs/workspaces"
import { Axond } from "../../src/axond"
import { Cli } from "../../src/control/cli"

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function store() {
    const workspace = await mkdtemp(join(tmpdir(), "axond-repository-jobs-"))
    roots.push(workspace)
    return RepositoryJobs({ workspace: workspace })
}

const human = { kind: "human" as const, account: "cody@example.com" }

describe("repository jobs", () => {
    test("stores the event stream under the repository's .agents/work directory", async () => {
        const jobs = await store()
        const job = await jobs.create({ brief: "Repair the deployment check", by: human })

        expect(jobs.root).toEndWith(".agents/work")
        expect(job.brief).toBe("Repair the deployment check")
        expect(await readFile(join(jobs.root, `${job.id}.jsonl`), "utf8")).toContain('"kind":"created"')
    })

    test("folds a current brief and one schedule from append-only events", async () => {
        const jobs = await store()
        const created = await jobs.create({ brief: "Deploy safely", by: human })

        jobs.brief({ ref: created.id, brief: "Fix failures, verify, then deploy safely", by: human })
        jobs.configureSchedule({ ref: created.id, every: "0 9 * * *", agent: "@axon/zero", prompt: "daily-deploy", context: "brief", by: human })
        jobs.pauseSchedule({ ref: created.id, by: human })

        const job = jobs.at(created.id)
        expect(job?.brief).toBe("Fix failures, verify, then deploy safely")
        expect(job?.schedule).toEqual({ every: "0 9 * * *", agent: "@axon/zero", prompt: "daily-deploy", context: "brief", paused: true, lastRunAt: null })
        expect(job?.events.map(event => event.kind)).toEqual(["created", "brief.updated", "schedule.configured", "schedule.paused"])
    })

    test("keeps separate attempts when a scheduled job runs again", async () => {
        const workspace = await mkdtemp(join(tmpdir(), "axond-repository-jobs-"))
        roots.push(workspace)
        const jobs = RepositoryJobs({
            workspace: workspace,
            start: async job => ({ session: `session-${job.run?.id}` }),
        })
        const created = await jobs.create({ brief: "Check the deployment", by: human })
        const first = jobs.at(created.id)?.run
        expect(first?.status).toBe("running")

        jobs.finish({ ref: created.id, run: first!.id, by: human, summary: "first pass" })
        jobs.configureSchedule({ ref: created.id, every: "0 9 * * *", agent: "@axon/zero", prompt: "daily check", context: "brief", by: human })
        await jobs.runScheduled(created.id)

        const job = jobs.at(created.id)
        expect(job?.runs).toHaveLength(2)
        expect(job?.runs[0]?.status).toBe("finished")
        expect(job?.runs[1]?.trigger).toBe("schedule")
        expect(job?.schedule?.lastRunAt).toBe(job?.runs[1]?.claimedAt)
    })

    test("-ap answers the run in progress with a proposal, and refuses when nothing is running", async () => {
        const workspace = await mkdtemp(join(tmpdir(), "axond-repository-jobs-"))
        roots.push(workspace)
        const jobs = RepositoryJobs({
            workspace: workspace,
            start: async job => ({ session: `session-${job.run?.id}` }),
        })
        const agent = { kind: "agent" as const, session: "s1" }
        const created = await jobs.create({ brief: "Scripts missing from the TUI", by: human })
        const run = jobs.at(created.id)!.run!

        const answered = jobs.answer({ ref: created.id, outcome: "proposal", text: "## Plan\n\n1. Fix it", by: agent })

        expect(answered.run?.id).toBe(run.id)
        expect(answered.run?.status).toBe("finished")
        expect(answered.run?.outcome).toBe("proposal")
        expect(answered.run?.summary).toBe("## Plan\n\n1. Fix it")
        // The run is over, so a second answer has nothing to answer.
        expect(() => jobs.answer({ ref: created.id, outcome: "report", text: "again", by: agent })).toThrow()
    })

    test("only keeps repository locations in daemon state", async () => {
        const daemon = await mkdtemp(join(tmpdir(), "axond-workspaces-"))
        const workspace = await mkdtemp(join(tmpdir(), "axond-repository-jobs-"))
        roots.push(daemon, workspace)
        const workspaces = Workspaces({ root: daemon })
        const work = workspaces.at(workspace)
        await work.jobs.create({ brief: "Triage test failures", by: human })

        expect(workspaces.list()).toEqual([workspace])
        expect(await readFile(join(workspace, ".agents", "work", `${work.jobs.list()[0]!.id}.jsonl`), "utf8")).toContain("Triage test failures")
    })

    test("the daemon CLI writes a job into the caller's repository", async () => {
        const daemon = await mkdtemp(join(tmpdir(), "axond-daemon-"))
        const workspace = await mkdtemp(join(tmpdir(), "axond-repository-jobs-"))
        roots.push(daemon, workspace)
        const cli = Cli({ axond: Axond({ root: daemon }) })

        await cli.jobCreate({ brief: "Repair the release pipeline", cwd: workspace }, true)

        const entries = await new Response(await cli.jobs(workspace, true, true)).json() as { jobs: Array<{ id: string }> }
        expect(entries.jobs).toHaveLength(1)
        expect(await readFile(join(workspace, ".agents", "work", `${entries.jobs[0]!.id}.jsonl`), "utf8")).toContain("Repair the release pipeline")
    })

    describe("the log as a record", () => {
        async function cli() {
            const daemon = await mkdtemp(join(tmpdir(), "axond-daemon-"))
            const workspace = await mkdtemp(join(tmpdir(), "axond-repository-jobs-"))
            roots.push(daemon, workspace)
            const commands = Cli({ axond: Axond({ root: daemon }) })
            const created = JSON.parse(await commands.jobCreate({ brief: "Map the rivers", cwd: workspace, id: "rivers" }, true)) as { id: string }
            return { commands, workspace, id: created.id }
        }
        async function events(commands: ReturnType<typeof Cli>, workspace: string, ref: string, since?: number) {
            return (JSON.parse(await commands.job(workspace, ref, true, since)) as { events: Array<Record<string, unknown>> }).events
        }

        const saved = process.env.AXON_ACTOR
        afterEach(() => { if (saved === undefined) delete process.env.AXON_ACTOR; else process.env.AXON_ACTOR = saved })

        test("a note is appended and starts nothing", async () => {
            const { commands, workspace, id } = await cli()
            await commands.jobSay(workspace, id, "probe found 46% undrawn", true, undefined, "rivers-commander")

            const log = await events(commands, workspace, id)
            expect(log.at(-1)).toMatchObject({ kind: "said", entry: "note", text: "probe found 46% undrawn", by: { kind: "agent", name: "rivers-commander" } })
            // No run was claimed or started: a note is a record, not a trigger.
            expect(log.map(event => event.kind)).toEqual(["created", "said"])
        })

        test("a report with no run in progress is a report entry, with its attachments", async () => {
            const { commands, workspace, id } = await cli()
            const evidence = join(workspace, "evidence.log")
            await Bun.write(evidence, "ok\n")
            await commands.jobAnswer(workspace, id, "report", "STATUS done", true, [evidence], "rivers-commander")

            const last = (await events(commands, workspace, id)).at(-1) as { kind: string; entry: string; attachments: Array<{ name: string }> }
            expect(last).toMatchObject({ kind: "said", entry: "report", text: "STATUS done" })
            expect(last.attachments.map(file => file.name)).toEqual(["evidence.log"])
            expect((await events(commands, workspace, id)).map(event => event.kind)).toEqual(["created", "said"])
            // A proposal still needs a run to answer.
            await expect(commands.jobAnswer(workspace, id, "proposal", "do it", true)).rejects.toThrow()
        })

        test("AXON_ACTOR names the author, --as wins over it, and a name never closes a job", async () => {
            const { commands, workspace, id } = await cli()
            process.env.AXON_ACTOR = "captain"
            await commands.jobSay(workspace, id, "from the env", true)
            await commands.jobSay(workspace, id, "from the flag", true, undefined, "rivers-commander")

            const log = await events(commands, workspace, id)
            expect(log.slice(-2).map(event => (event.by as { name?: string }).name)).toEqual(["captain", "rivers-commander"])
            await expect(commands.jobDone(workspace, id, true)).rejects.toThrow()
            delete process.env.AXON_ACTOR
            await expect(commands.jobDone(workspace, id, true, "captain")).rejects.toThrow()
        })

        test("the thread shows each entry's #seq and author, and --since shows only what is newer", async () => {
            const { commands, workspace, id } = await cli()
            await commands.jobSay(workspace, id, "first", true, undefined, "captain")
            await commands.jobSay(workspace, id, "second", true, undefined, "rivers-commander", "report")

            const full = await commands.job(workspace, id)
            expect(full).toContain("#1  captain  first")
            expect(full).toContain("#2  rivers-commander  report: second")

            const newer = await commands.job(workspace, id, false, 1)
            expect(newer).not.toContain("first")
            expect(newer).toContain("#2  rivers-commander  report: second")
            expect((await events(commands, workspace, id, 1)).map(event => event.seq)).toEqual([2])
        })

        test("an old entry with no type or name still reads", async () => {
            const { commands, workspace, id } = await cli()
            const file = join(workspace, ".agents", "work", `${id}.jsonl`)
            await Bun.write(file, (await readFile(file, "utf8")) + JSON.stringify({ kind: "said", at: new Date().toISOString(), by: { kind: "agent", session: "anonymous" }, text: "legacy" }) + "\n")
            expect(await commands.job(workspace, id)).toContain("#1  agent  legacy")
        })
    })
})
