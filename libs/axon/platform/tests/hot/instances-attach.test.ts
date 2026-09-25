import { describe, expect, it } from "bun:test"
// Imported from the file rather than the module index: Instances is
// internal — Runtime() is the module's entry point — and widening the
// public surface to make a test convenient is the wrong trade.
import { Instances } from "../../src/build/runtime/instances"

/**
 * attach() — binding to an agent this process does not own.
 *
 * The rule under test is ONE BINDING PER AGENT. Two handles onto one remote
 * session would both write to it, which breaks the one-session-one-writer
 * invariant the remote handle exists to hold. That guard used to key on
 * `deploymentId`; a dev server has none, so it keys on the URL — the one thing
 * a deployment and a bare address both always have.
 *
 * Only `cloud` is exercised: Instances() is pure wiring at construction (no
 * disk, no network), so the remaining dependencies are never touched on this
 * path and are stubbed as empty rather than built.
 */

/** A fake cloud whose attach() records what it was asked for. */
function cloud(sessionIdFor: (url: string) => string = () => "session-1") {
    const attached: string[] = []
    return {
        attached,
        client: {
            attach: async (url: string) => {
                attached.push(url)
                return {
                    axon: { session: {} } as never,
                    sessionId: sessionIdFor(url),
                    agent: "@axon/zeno",
                }
            },
        },
    }
}

function instances(fake: ReturnType<typeof cloud>) {
    return Instances({
        store: {} as never,
        projects: {} as never,
        resolve: {} as never,
        cwd: "/tmp",
        cloud: fake.client as never,
        host: {} as never,
    })
}

describe("attach: one binding per agent", () => {
    it("attaching twice to the same url reuses the first instance", async () => {
        const fake = cloud()
        const registry = instances(fake)

        const first = await registry.attach({ url: "http://localhost:3010", name: "" })
        const second = await registry.attach({ url: "http://localhost:3010", name: "" })

        expect(second.sessionId).toBe(first.sessionId)
        // The second call never reached the network: a second binding is not
        // opened, it is refused in favour of the one that exists.
        expect(fake.attached.length).toBe(1)
    })

    it("a trailing slash is the same agent", async () => {
        // Two spellings of one address must not become two writers. This is
        // the whole reason the url is normalized before the guard runs.
        const fake = cloud()
        const registry = instances(fake)

        await registry.attach({ url: "http://localhost:3010", name: "" })
        await registry.attach({ url: "http://localhost:3010/", name: "" })

        expect(fake.attached.length).toBe(1)
    })

    it("a differing host is a different agent", async () => {
        const fake = cloud(url => (url.includes("3010") ? "dev" : "other"))
        const registry = instances(fake)

        const first = await registry.attach({ url: "http://localhost:3010", name: "" })
        const second = await registry.attach({ url: "http://localhost:3011", name: "" })

        expect(second.sessionId).not.toBe(first.sessionId)
        expect(fake.attached.length).toBe(2)
    })
})

describe("attach: identity", () => {
    it("takes the name from the handshake when the caller has none", async () => {
        // A typed URL carries no identity. Falling back to the address would
        // put a hostname where an agent name belongs.
        const fake = cloud()
        const registry = instances(fake)

        const instance = await registry.attach({ url: "http://localhost:3010", name: "" })

        expect(instance.source.kind).toBe("remote")
        if (instance.source.kind !== "remote") throw new Error("expected a remote instance")
        expect(instance.source.target.name).toBe("@axon/zeno")
    })

    it("keeps a caller-supplied name over the handshake's", async () => {
        // A deployment is named by the control plane's record, which is what
        // the user picked it by — the agent's own name must not override it.
        const fake = cloud()
        const registry = instances(fake)

        const instance = await registry.attach({
            url: "https://dave.axon.run",
            name: "@cody/dave",
            agentId: "agent-1",
            deploymentId: "dep-1",
        })

        if (instance.source.kind !== "remote") throw new Error("expected a remote instance")
        expect(instance.source.target.name).toBe("@cody/dave")
        expect(instance.source.target.deploymentId).toBe("dep-1")
    })

    it("a remote instance is always a root conversation", async () => {
        const fake = cloud()
        const registry = instances(fake)

        const instance = await registry.attach({ url: "http://localhost:3010", name: "" })

        expect(instance.parentSessionId).toBeNull()
        expect(instance.rootSessionId).toBe(instance.sessionId)
        expect(instance.depth).toBe(0)
    })
})

describe("attach: detaching never stops the agent", () => {
    it("stop() drops the handle and shuts nothing down", async () => {
        // The agent is owned by whoever started it — a dev server in another
        // terminal, or a deployment. `:close` detaches; it does not reach
        // across and kill someone else's process.
        const fake = cloud()
        const registry = instances(fake)

        const instance = await registry.attach({ url: "http://localhost:3010", name: "" })
        await registry.stop(instance.sessionId)

        expect(registry.recent().some(item => item.sessionId === instance.sessionId)).toBe(false)
    })
})
