import type { FrameworkSource } from "./manifest/package"
import { dirname, join, resolve } from "node:path"
import type { AxonCloudClient } from "@arcforge/cloud"
import { err } from "@arcforge/err"
import { fsx } from "../../utils/fs"
import { KINDS, detectKind, type ProjectKind } from "./kinds"
import { Project, type ProjectT } from "./project"
import type { BenchExtras } from "../bench"
import type { ProviderEntry } from "@arcforge/types"

type ProjectsOpts = {
    cloud: AxonCloudClient
    /** CLI version — scaffolded projects pin @arcforge/types + @arcforge/engines to it exactly. */
    frameworkVersion: string
    frameworkSource?: FrameworkSource
    repoRoot?: string
    /** Invocation directory used for workspace discovery. */
    cwd?: string
    /** Collaborators a bench project needs — the test runner and agent resolution. */
    bench: BenchExtras
    /**
     * The active profile's declared inference sources, read fresh per call.
     *
     * A FUNCTION, not a value: the active profile changes while the process
     * runs (a user switches profiles) and a captured array would keep serving
     * the one that was active at boot.
     *
     * Injected rather than read here because this layer deliberately knows
     * nothing about auth or profiles — it resolves WHICH directory and WHAT
     * kind, and a store lookup would give it an opinion about which user is
     * running. The composition root knows; this carries.
     */
    profileProviders?: () => Promise<readonly ProviderEntry[] | undefined>
}

/**
 * Projects — finds, opens, and creates agent/module projects. The entry
 * point of project management: resolves WHICH directory and WHAT kind,
 * the question Blueprint deliberately refuses to answer.
 *
 * Auth never appears here — registry access flows through the injected
 * cloud client and fails loudly at the call site when logged out.
 */
export function Projects(opts: ProjectsOpts) {
    // A project owns its prepared-build cache and the watcher that validates
    // it. Reopening the same root must therefore return the same handle;
    // constructing a fresh Project() per spawn discarded both and guaranteed
    // a full reconciliation after every close → reopen.
    const opened = new Map<string, ProjectT>()

    async function open(root: string, cwd = opts.cwd): Promise<ProjectT> {
        const absolute = resolve(root)
        const kind = detectKind(absolute)

        if (!kind) {
            throw err("PROJECT_NOT_FOUND", { context: { path: absolute } })
        }

        const existing = opened.get(absolute)
        if (existing) return existing

        const project = Project({
            root: absolute,
            kind: kind,
            name: await projectName(absolute),
            cloud: opts.cloud,
            frameworkVersion: opts.frameworkVersion,
            ...(cwd ? { cwd } : {}),
        ...(opts.frameworkSource ? { frameworkSource: opts.frameworkSource } : {}),
        ...(opts.repoRoot ? { repoRoot: opts.repoRoot } : {}),
            bench: opts.bench,
            ...(opts.profileProviders ? { profileProviders: opts.profileProviders } : {}),
        })
        opened.set(absolute, project)
        return project
    }

    /** Open the project at or above cwd, refusing anything that isn't `kind`. */
    async function openAs(kind: ProjectKind, cwd: string): Promise<ProjectT> {
        const root = find(cwd)
        if (!root) {
            throw err("PROJECT_NOT_FOUND", {
                detail: `no ${KINDS[kind].config} at or above ${cwd}`,
                context: { path: cwd, kind },
            })
        }
        // Workspace discovery belongs to this invocation, not the long-lived
        // terminal process that happened to create the platform.
        const project = await open(root, cwd)
        if (project.kind !== kind) {
            throw err("PROJECT_WRONG_KIND", {
                detail: `${project.root} is a ${project.kind} project, not a ${kind}`,
                context: { root: project.root, expected: kind, actual: project.kind },
            })
        }
        return project
    }

    /** Walk up from cwd to the nearest project root. Null when outside any project. */
    function find(cwd: string = process.cwd()): string | null {
        let current = resolve(cwd)
        while (true) {
            if (detectKind(current)) return current
            const parent = dirname(current)
            if (parent === current) return null
            current = parent
        }
    }

    return {
        open: open,
        openAs: openAs,
        find: find,

        /**
         * Scaffold a project of any kind at <dir>/<name>/ and open it.
         *
         * One path for all five kinds. The scaffolder writes source; prepare()
         * declares + installs the framework deps and generates the type frame
         * — the same path that self-heals an older project, so init and
         * prepare share one dependency story. prepare() is unconditional:
         * kinds with nothing to prepare (prompt packages) no-op inside it
         * rather than relying on this caller to remember to skip them.
         */
        async create(
            kind: ProjectKind,
            input: {
                name: string
                dir?: string
                apiBase?: string
                /**
                 * Observe the two phases this composes.
                 *
                 * Scaffolding writes files in milliseconds; prepare resolves
                 * and installs a dependency tree and can run for seconds. A
                 * caller rendering one spinner over both is rendering a
                 * spinner over the install and calling it something else.
                 */
                onProgress?: (step: CreateStep) => void
            },
        ): Promise<ProjectT> {
            const report = input.onProgress ?? (() => {})

            report({ step: "scaffolding" })
            const scaffolded = await KINDS[kind].scaffold({
                name: input.name,
                dir: input.dir ?? process.cwd(),
                frameworkVersion: opts.frameworkVersion,
        ...(opts.frameworkSource ? { frameworkSource: opts.frameworkSource } : {}),
        ...(opts.repoRoot ? { repoRoot: opts.repoRoot } : {}),
                ...(input.apiBase !== undefined ? { apiBase: input.apiBase } : {}),
            })

            /*
             * What was scaffolded is not always a project of its own.
             *
             * `axon cognet init` inside an agent writes an INLINE cognet at
             * <agent>/cognet/ — deliberately with no package.json, because it
             * is part of the agent rather than a second publishable package.
             * `detectKind()` refuses to claim such a directory, equally
             * deliberately. So opening the scaffolded path threw
             * PROJECT_NOT_FOUND against a directory this function had just
             * written, one line after reporting success: the scaffolder was
             * right and the step after it had not been told.
             *
             * The project to open — and to PREPARE, since an inline cognet is
             * compiled from the agent's node_modules into the agent's frame —
             * is the one that OWNS the scaffolded path. For every other kind
             * that owner is the scaffolded path itself.
             */
            const root = detectKind(scaffolded) ? scaffolded : find(scaffolded)
            if (!root) {
                throw err("PROJECT_NOT_FOUND", {
                    detail: `scaffolded ${scaffolded} but found no project at or above it`,
                    context: { path: scaffolded, kind },
                })
            }
            const project = await open(root)

            report({ step: "preparing", root })
            await project.prepare()

            /*
             * The step describes WHAT WAS CREATED, which for an inline cognet
             * is the cognet — not the agent that now owns it. Reporting the
             * agent's root and name here would tell a user who asked for a
             * cognet that they had made an agent.
             */
            report({
                step: "created",
                root: scaffolded,
                name: root === scaffolded ? project.name : input.name,
            })
            return project
        },
    }
}

/** Phases surfaced through create()'s onProgress. */
export type CreateStep =
    | { step: "scaffolding" }
    | { step: "preparing"; root: string }
    | { step: "created"; root: string; name: string }

export type ProjectsT = ReturnType<typeof Projects>

/** package.json name, falling back to the directory basename. */
async function projectName(root: string): Promise<string> {
    const text = await fsx.readText(join(root, "package.json"))
    if (text) {
        const name = (JSON.parse(text) as { name?: string }).name
        if (name) return name
    }
    return root.split("/").pop()!
}
