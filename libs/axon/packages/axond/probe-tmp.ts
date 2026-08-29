import { Platform } from "@arcforge/platform/platform"
import { Agent } from "@arcforge/platform/build/runtime"
import { Axond } from "./src/index"

const platform = Platform({ version: "0.0.0", distribution: "production" })
await platform.refreshSettings()

const root = "/home/cody/git/arclabs/registry/agents/barry.mk3"
const project = await platform.projects.open(root)
const axond = Axond({ cloud: platform.cloud.client })

/**
 * THE SPLIT, exercised: Agent() builds (prepare, load, spans) and hands the
 * blueprint to `confined`; the daemon supervises what it is handed.
 */
const agent = await Agent({
    project: project,
    cwd: root,
    cloud: platform.cloud.client,
    store: platform.store,
    confined: async ({ blueprint, sessionId }) => {
        console.log("→ daemon supervising", blueprint.agent?.name)
        const handle = await axond.agents.spawn({
            sessionId: sessionId,
            blueprint: blueprint as never,
            agent: blueprint.agent?.name ?? project.name,
            projectRoot: root,
            dataRoot: `${root}/.agent/data`,
        })
        return handle.agent as never
    },
} as never)

console.log("agent booted:", (agent as any).sessionId?.slice(0, 8))
await axond.agents.dispose()
