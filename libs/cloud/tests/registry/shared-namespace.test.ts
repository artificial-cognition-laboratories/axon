import { AxonCloud } from "../../src"
import { TEST_USER } from "../setup/user"
import { backendUrl } from "../setup/staging"

/**
 * The registry name namespace is SHARED across agents and modules: a given
 * `@scope/name` is exactly one artifact, and the unified resolve finds it
 * whichever kind it is. These are the two guarantees that make `axon clone`
 * work without a kind flag.
 */
const baseUrl = backendUrl()

function scopedName(prefix: string): string {
    return `@testuser/${prefix}-${crypto.randomUUID().slice(0, 8)}`
}

describe("registry shared namespace", () => {
    it("rejects a module whose name is already taken by an agent (409)", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const name = scopedName("collide-agent-first")

        await cloud.registry.artifacts.of("agent").create({ name })

        await expect(
            cloud.registry.artifacts.of("module").create({ name }),
        ).rejects.toThrow(/already taken by an agent/)
    })

    it("rejects an agent whose name is already taken by a module (409)", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const name = scopedName("collide-module-first")

        await cloud.registry.artifacts.of("module").create({ name })

        await expect(
            cloud.registry.artifacts.of("agent").create({ name }),
        ).rejects.toThrow(/already taken by a module/)
    })

    it("re-registering the same agent name is idempotent, not a self-collision", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const name = scopedName("idempotent-agent")

        const first = await cloud.registry.artifacts.of("agent").create({ name })
        const second = await cloud.registry.artifacts.of("agent").create({ name })

        expect(second.id).toBe(first.id)
    })

    it("unified resolve returns kind:agent for an agent name", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const name = scopedName("resolve-agent")
        await cloud.registry.artifacts.of("agent").create({ name })

        // No published version yet, so resolve surfaces "no published versions"
        // rather than a download — but reaching that error proves it found the
        // AGENT row (a wrong-table lookup would 404 "no agent or module found").
        await expect(cloud.registry.resolve(name)).rejects.toThrow(/no published versions/i)
    })

    it("unified resolve 404s for a name in neither table", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        await expect(
            cloud.registry.resolve(scopedName("nonexistent")),
        ).rejects.toThrow(/no artifact found/i)
    })
})
