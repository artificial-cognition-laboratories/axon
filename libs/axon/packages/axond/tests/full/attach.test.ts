import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Platform, type PlatformT } from "@arcforge/platform/platform"
import { Network, type SimMachine } from "../setup/network"
import { seedMockProvider } from "../setup/supervised"
import { TEST_FRAMEWORK, TEST_VERSION } from "../setup/user"

/**
 * Attaching to an agent on another machine — a real agent, supervised by the
 * far daemon, reached from a terminal on this one through its own daemon and
 * the network, over the same `/_axon/*` contract a deployed agent serves.
 */
const network = Network()
const dirs: string[] = []
let platform: PlatformT | null = null
afterEach(async () => {
    await platform?.agents.shutdown()
    platform = null
    await network.dispose()
    await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/** A mock agent, running under `machine`'s daemon — exactly how the terminal wires supervision. */
async function running(machine: SimMachine): Promise<string> {
    seedMockProvider(machine.axond.paths.store)
    platform = Platform({ version: TEST_VERSION, ...TEST_FRAMEWORK, store: machine.axond.paths.store, daemon: machine.axond.agents })
    const dir = await mkdtemp(join(tmpdir(), "axn-agent-"))
    dirs.push(dir)
    const project = await platform.projects.create("agent", { name: `remote-${crypto.randomUUID().slice(0, 8)}`, dir: dir })
    await writeFile(join(project.root, "axon.config.ts"), `export default defineAgent({ providers: [Mock()], model: "mock:mock" })\n`)
    const instance = await platform.agents.spawn(project)
    return instance.sessionId
}

describe("attach across machines", () => {
    test("a terminal attaches to an agent on another machine and talks to it", async () => {
        const laptop = await network.machine("laptop", { network: true })
        const homelab = await network.machine("homelab", { network: true })
        const session = await running(homelab)
        const there = await homelab.client.net.status()
        if (there.state !== "up") throw new Error("homelab is not on the network")

        const attached = await laptop.client.machines.at(there.id).attach(session)
        expect(attached.sessionId).toBe(session)

        const result = await attached.axon.request("hello from the laptop")
        expect(result).toBeDefined()

        // The stream is where attach lives: entries must arrive as an event
        // stream through both daemons and the network, not buffered whole.
        const entries: unknown[] = []
        for await (const entry of attached.axon.stream("and again, streamed").stream) entries.push(entry)
        expect(entries.length).toBeGreaterThan(0)
    }, 120_000)
})
