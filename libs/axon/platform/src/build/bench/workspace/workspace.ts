import type { BenchResolvedWorkspaceDefinition } from "@arcforge/types"
import { prepareWorkspaceTemplate } from "./files"

export function Workspace(opts: { root: string; definition: BenchResolvedWorkspaceDefinition }) {
    let prepared: Awaited<ReturnType<typeof prepareWorkspaceTemplate>> | undefined
    return {
        async prepare() {
            prepared ??= await prepareWorkspaceTemplate(opts.root, opts.definition)
            return prepared
        },
    }
}

export type WorkspaceT = ReturnType<typeof Workspace>
