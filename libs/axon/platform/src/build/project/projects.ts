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
    async function open(root: string): Promise<ProjectT> {
        const absolute = resolve(root)
        const kind = detectKind(absolute)

        if (!kind) {
            throw err("PROJECT_NOT_FOUND", { context: { path: absolute } })
        }

        return Project({
            root: absolute,
            kind: kind,
            name: await projectName(absolute),
            cloud: opts.cloud,
            frameworkVersion: opts.frameworkVersion,
        ...(opts.frameworkSource ? { frameworkSource: opts.frameworkSource } : {}),
        ...(opts.repoRoot ? { repoRoot: opts.repoRoot } : {}),
            bench: opts.bench,
            ...(opts.profileProviders ? { profileProviders: opts.profileProviders } : {}),
        })
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
        const project = await open(root)
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
            const root = await KINDS[kind].scaffold({
                name: input.name,
                dir: input.dir ?? process.cwd(),
                frameworkVersion: opts.frameworkVersion,
        ...(opts.frameworkSource ? { frameworkSource: opts.frameworkSource } : {}),
        ...(opts.repoRoot ? { repoRoot: opts.repoRoot } : {}),
                ...(input.apiBase !== undefined ? { apiBase: input.apiBase } : {}),
            })
            const project = await open(root)

            report({ step: "preparing", root })
            await project.prepare()

            report({ step: "created", root, name: project.name })
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
