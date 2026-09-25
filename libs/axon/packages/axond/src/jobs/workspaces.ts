import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { RepositoryWork, type RepositoryWorkT } from "./repository-work"
import type { Job } from "./types"

type WorkspacesOpts = {
    root: string
    machineId?: () => string | null
    start?: (job: Job) => Promise<{ session: string }>
}

/** Workspaces — daemon-local discovery of repositories; job data remains in each repository. */
export function Workspaces(opts: WorkspacesOpts) {
    const path = join(opts.root, "workspaces.json")

    function list(): string[] {
        if (!existsSync(path)) return []
        const value: unknown = JSON.parse(readFileSync(path, "utf8"))
        if (!Array.isArray(value) || value.some(entry => typeof entry !== "string")) {
            throw new Error(`workspace registry is invalid: ${path}`)
        }
        return value
    }

    function register(workspace: string): string {
        const root = resolve(workspace)
        const known = list()
        if (known.includes(root)) return root
        mkdirSync(opts.root, { recursive: true })
        const temporary = `${path}.${process.pid}.tmp`
        writeFileSync(temporary, JSON.stringify([...known, root], null, 2) + "\n")
        renameSync(temporary, path)
        return root
    }

    function at(workspace: string): RepositoryWorkT {
        const root = register(workspace)
        return RepositoryWork({
            workspace: root,
            ...(opts.machineId ? { machineId: opts.machineId } : {}),
            ...(opts.start ? { start: opts.start } : {}),
        })
    }

    return { list: list, register: register, at: at }
}

export type WorkspacesT = ReturnType<typeof Workspaces>
