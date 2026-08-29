import { AxonCloud } from "../../src"
import { withIdentity } from "../setup/identity"
import { backendUrl, databaseUrl } from "../setup/staging"
import { fixtureBundle } from "../deployments/fixtures"

/**
 * A deployment key may only ever name its own agent.
 *
 * `confineToAgent()` is what stops one deployed agent acting on a sibling
 * belonging to the same user. It was enforced on all nine `/api/agents/:id/*`
 * routes and on NONE of the ten `/api/artifacts/:id/*` routes — the general
 * surface over the same `registry_artifacts` rows. An agent-bound key could
 * read a sibling agent, patch it, star it, and obtain a signed URL to a
 * PRIVATE sibling's source tarball, purely by addressing the artifacts path
 * instead of the agents path. The modules aliases had the same gap.
 *
 * Ownership checks cannot catch this and never could: a deployment key belongs
 * to the agent's owner, so `canManageRegistryResource` returns true, correctly.
 * Ownership asks "whose is this"; confinement asks "which agent may this
 * credential name". Only the first was being asked.
 *
 * So the assertion is over the WIRE and per route family: a static check can
 * confirm a helper is called, but only a real request confirms what the server
 * actually serves. Every path that reaches an artifact row is exercised
 * against a sibling the key was not issued for.
 */

const baseUrl = backendUrl()

/** Mint a deployment-style key confined to one agent, exactly as identity.ts does. */
async function agentBoundKey(input: { userId: string; agentId: string }): Promise<string> {
    const { createHash, randomBytes } = await import("node:crypto")
    const key = `axon_${randomBytes(20).toString("hex")}`
    const keyHash = createHash("sha256").update(key).digest("hex")

    // DEPLOYMENT_SCOPES, verbatim — the point is that a key with legitimate
    // read scopes is still refused a sibling agent.
    const scopes = "{engine:invoke,events:ingest,agents:read,modules:read,cognets:read,vault:read}"
    const proc = Bun.spawn([
        "psql", databaseUrl(), "-v", "ON_ERROR_STOP=1", "-c",
        `insert into api_keys (user_id, name, key_hash, type, agent_id, scopes)`
        + ` values ('${input.userId}', 'test-confinement-${randomBytes(4).toString("hex")}',`
        + ` '${keyHash}', 'agent', '${input.agentId}', '${scopes}')`,
    ], { stdout: "pipe", stderr: "pipe" })

    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
    if (code !== 0) throw new Error(`failed to mint agent-bound key: ${stderr}`)
    return key
}

describe("agent-bound key confinement", () => {
    it("refuses a sibling agent on every route that reaches an artifact row", async () => {
        await withIdentity("confinement", async ({ cloud, who }) => {
            // Two agents, same owner. `mine` is what the key is issued
            // against; `sibling` is private and carries a published version,
            // so its source tarball is the highest-value target in the system.
            const mine = await cloud.registry.artifacts.create({ kind: "agent", name: `@${who.username}/confine-mine` })
            const sibling = await cloud.registry.artifacts.create({ kind: "agent", name: `@${who.username}/confine-sibling`, private: true })

            const bundle = await fixtureBundle({ version: "0.0.1" })
            try {
                await sibling.publish({ path: bundle.path })
            } finally {
                await bundle.cleanup()
            }

            const key = await agentBoundKey({ userId: who.id, agentId: mine.id })
            const confined = AxonCloud({ baseUrl, key })

            // Every verb the client can aim at a sibling. A confined key must
            // see 404 — absence, not refusal: an agent key learning that
            // another agent exists is itself a leak.
            const target = confined.registry.artifacts.artifact(sibling.id)
            await expect(target.get()).rejects.toThrow()
            await expect(target.versions()).rejects.toThrow()
            await expect(target.stats()).rejects.toThrow()
            await expect(target.star()).rejects.toThrow()
            await expect(target.unstar()).rejects.toThrow()
            await expect(target.update({ description: "written by a sibling" })).rejects.toThrow()
            await expect(target.dependents()).rejects.toThrow()
            await expect(target.dependencies("0.0.1")).rejects.toThrow()

            // The severe one: a signed URL to a private sibling's source.
            await expect(target.downloadUrl("0.0.1")).rejects.toThrow()

            // The kind-bound view resolves through the same handle, so a
            // caller that knows it holds an agent is confined identically.
            await expect(confined.registry.artifacts.of("agent").handle(`@${who.username}/confine-sibling`)).rejects.toThrow()

            // The mutations must not have landed. Read back as the OWNER,
            // whose view is authoritative: a 404 to the confined caller would
            // be worthless if the write had already been applied.
            const after = await cloud.registry.artifacts.artifact(sibling.id).get()
            expect(after.description).toBeNull()
            expect(after.starsCount).toBe(0)
        })
    })

    it("still permits the key against its own agent", async () => {
        await withIdentity("confinement-self", async ({ cloud, who }) => {
            // The other half of the contract: confinement must not break the
            // thing a deployment key exists to do. A test asserting only the
            // refusals would pass if confineToAgent rejected everything.
            const mine = await cloud.registry.artifacts.create({ kind: "agent", name: `@${who.username}/confine-self` })

            const key = await agentBoundKey({ userId: who.id, agentId: mine.id })
            const confined = AxonCloud({ baseUrl, key })

            const record = await confined.registry.artifacts.artifact(mine.id).get()
            expect(record.artifactId).toBe(mine.id)
        })
    })

    it("confines by resolved row, not by the string the caller passed", async () => {
        await withIdentity("confinement-name", async ({ cloud, who }) => {
            // Artifacts are addressable by uuid OR by scoped name. If
            // confinement ran on the raw path parameter rather than the row it
            // resolved to, naming the sibling differently than the key was
            // issued against would walk straight past it.
            const mine = await cloud.registry.artifacts.create({ kind: "agent", name: `@${who.username}/confine-byname-mine` })
            const sibling = await cloud.registry.artifacts.create({ kind: "agent", name: `@${who.username}/confine-byname-other` })

            const key = await agentBoundKey({ userId: who.id, agentId: mine.id })
            const confined = AxonCloud({ baseUrl, key })

            await expect(
                confined.registry.artifacts.artifact(`@${who.username}/confine-byname-other`).get(),
            ).rejects.toThrow()

            // ...while the key's own agent still resolves by name.
            const self = await confined.registry.artifacts.artifact(`@${who.username}/confine-byname-mine`).get()
            expect(self.artifactId).toBe(mine.id)
            expect(sibling.id).not.toBe(mine.id)
        })
    })
})
