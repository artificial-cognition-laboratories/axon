import { AxonCloud } from "../../src"
import { TEST_USER, scopedName } from "../setup/user"
import { fixtureBundle } from "./fixtures"
import { backendUrl } from "../setup/staging"

const baseUrl = backendUrl()

/** Scoped to the seeded test user — the registry rejects flat global names. */

/**
 * Managed identity — what a deployed agent is injected with, asserted through
 * the only interface that matters: AxonCloud.
 *
 * The failure this guards against was real and silent: an agent-scoped key was
 * minted at publish, never injected into the container, and carried no engine
 * scope anyway. So the agent had a credential it never received, which could not
 * have called inference even if it had. Nothing errored until a user tried to
 * talk to their deployed agent.
 */
describe("deployment identity", () => {
    it("injects the platform's runtime credential alongside the user's own secrets", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const bundle = await fixtureBundle({ version: "0.0.1" })

        try {
            const { deployment } = await cloud.registry.agents.deploy({
                name: scopedName(),
                path: bundle.path,
                tier: "small",
                env: { TEST_SECRET: "hunter2" },
            })

            const injected = await deployment.secrets.list()

            // The agent's own key — without this it cannot reach the engine.
            expect(injected).toContain("AXON_API_KEY")
            // A user secret must survive the platform's own write: both go through
            // one replace() call, and that call deletes whatever it is not given.
            expect(injected).toContain("TEST_SECRET")

            await deployment.delete()
        } finally {
            await bundle.cleanup()
        }
    }, 30_000)

    it("refuses a deploy whose secrets collide with a platform-owned name", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const bundle = await fixtureBundle({ version: "0.0.1" })

        try {
            // AXON_API_BASE decides which control plane the agent's connect gate
            // trusts. User env spreads last in the container spec, so before the
            // guard this silently overrode the real one — an author could point
            // their agent's authentication at a server of their choosing.
            await expect(
                cloud.registry.agents.deploy({
                    name: scopedName(),
                    path: bundle.path,
                    tier: "small",
                    env: { AXON_API_BASE: "https://attacker.example" },
                }),
            ).rejects.toThrow(/Reserved environment variable/)
        } finally {
            await bundle.cleanup()
        }
    }, 30_000)

    it("revokes the runtime credential when the deployment is removed", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })
        const bundle = await fixtureBundle({ version: "0.0.1" })

        try {
            const { deployment } = await cloud.registry.agents.deploy({
                name: scopedName(),
                path: bundle.path,
                tier: "small",
            })

            const before = await cloud.user.keys.list()
            const runtimeKey = before.find(key => key.name === `deployment:${deployment.id}`)
            expect(runtimeKey).toBeDefined()
            expect(runtimeKey!.isActive).toBe(true)
            // Narrow by construction: inference and telemetry, never publish or billing.
            expect(runtimeKey!.scopes).toContain("engine:invoke")
            expect(runtimeKey!.scopes).not.toContain("modules:publish")
            expect(runtimeKey!.scopes).not.toContain("billing:read")

            await deployment.delete()

            // A torn-down agent holding a live key is a credential with no owner.
            const after = await cloud.user.keys.list()
            expect(after.find(key => key.name === `deployment:${deployment.id}`)?.isActive).toBe(false)
        } finally {
            await bundle.cleanup()
        }
    }, 30_000)
})
