import { Renderer } from "@arcforge/arcline"
import { AxonDaemon } from "../../client"
import type { AxondT } from "../../axond"
import { Format } from "./format"
import { Lifetime } from "./lifetime"
import { MachineCommands } from "./machine"
import { CatalogCommands } from "./catalog"
import { JobCommands } from "./jobs"
import { ModelCommands } from "./models"
import { PreferenceCommands } from "./preferences"
import { DictationCommands } from "./dictation"
import { WatchCommands } from "./watch"

/** The daemon's CLI is a flat public grammar assembled from domain handles. */
export function Cli(opts: { axond: AxondT }) {
    const renderer = Renderer()
    const format = Format({})
    const client = AxonDaemon({ root: opts.axond.paths.root })
    const lifetime = Lifetime({ axond: opts.axond, renderer: renderer, format: format, client: client })
    const machine = MachineCommands({ axond: opts.axond, renderer: renderer, format: format, client: client })
    const catalog = CatalogCommands({ axond: opts.axond, renderer: renderer, format: format, client: client })
    const jobs = JobCommands({ axond: opts.axond, renderer: renderer, format: format, client: client })
    const models = ModelCommands({ axond: opts.axond, renderer: renderer, format: format, client: client })
    const preferences = PreferenceCommands({ axond: opts.axond, renderer: renderer, format: format, client: client })
    const dictation = DictationCommands({ axond: opts.axond, renderer: renderer, format: format, client: client })
    const watch = WatchCommands({ axond: opts.axond, renderer: renderer, format: format, client: client })

    return {
        up: lifetime.up,
        down: lifetime.down,
        boot: lifetime.boot,
        status: lifetime.status,
        disable: lifetime.disable,
        serve: lifetime.serve,
        help: lifetime.help,
        failure: lifetime.failure,
        budget: machine.budget,
        machine: machine.machine,
        agents: machine.agents,
        stopAgent: machine.stopAgent,
        runtimes: catalog.runtimes,
        installRuntime: catalog.installRuntime,
        removeRuntime: catalog.removeRuntime,
        catalog: catalog.catalog,
        model: catalog.model,
        jobCreate: jobs.jobCreate,
        jobs: jobs.jobs,
        job: jobs.job,
        jobSay: jobs.jobSay,
        jobAnswer: jobs.jobAnswer,
        jobBrief: jobs.jobBrief,
        jobTitle: jobs.jobTitle,
        jobReopen: jobs.jobReopen,
        jobSchedule: jobs.jobSchedule,
        jobPause: jobs.jobPause,
        jobDone: jobs.jobDone,
        jobCancel: jobs.jobCancel,
        jobRetry: jobs.jobRetry,
        models: models.models,
        fetch: models.fetch,
        download: models.download,
        downloads: models.downloads,
        cancelDownload: models.cancelDownload,
        remove: models.remove,
        pin: models.pin,
        autoload: models.autoload,
        run: models.run,
        unload: models.unload,
        preference: preferences.preference,
        dictate: dictation.dictate,
        watch: watch.watch,
    }
}

export type CliT = ReturnType<typeof Cli>
