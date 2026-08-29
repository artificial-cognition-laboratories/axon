import { afterAll, describe, expect, it } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { spawnConfined } from "../../../src/confined"
import { agentSource, cleanup, inAgent, status, tempDir } from "./harness"
import type { AxonBlueprint, CapsulePolicy } from "@arcforge/types"

/**
 * THE PRODUCTION PATH.
 *
 * Every other wall test builds a box from the confinement builders. These call
 * `spawnConfined()` — the function the platform and the daemon actually use —
 * and that gap once shipped two real bugs:
 *
 *   1. slirp4netns was handed `child.pid`, the systemd-run/bwrap pid, which
 *      stays in the HOST's namespaces. It refused with "setns: Operation not
 *      permitted", the in-box launcher waited for a tap device that never came,
 *      and EVERY agent with a `net` policy would have failed to boot.
 *   2. `--clearenv` stripped DBUS_SESSION_BUS_ADDRESS from the WRAPPER chain,
 *      so `systemd-run --user` died with "Failed to connect to bus" and every
 *      confined agent failed to boot — with an error naming dbus rather than
 *      anything a reader would connect to policy.
 *
 * Both were invisible because the integration tests carried their own correct
 * spawn while production carried a broken one. Two implementations, one tested,
 * and the untested one is the one that ships.
 */

const boxed = status.auto ? describe : describe.skip

afterAll(cleanup)

boxed("spawnConfined — the path production actually uses", () => {
    it("boots an agent inside a real box and hears back from it", async () => {
        // The baseline. Without this every assertion below could pass on an
        // agent that never started.
        const seen = await inAgent(`outcome = "alive"`, {})
        expect(seen).toContain("probe:alive")
    }, 60_000)

    it("does not carry a host secret into the box", async () => {
        process.env.AXON_PROD_PROBE_SECRET = "must-not-cross"
        try {
            const seen = await inAgent(
                `outcome = process.env.AXON_PROD_PROBE_SECRET ? "LEAKED" : "clean"`,
                {},
            )
            expect(seen).toContain("probe:clean")
            expect(seen).not.toContain("probe:LEAKED")
        } finally {
            delete process.env.AXON_PROD_PROBE_SECRET
        }
    }, 60_000)

    it("carries a variable the policy granted", async () => {
        process.env.AXON_PROD_GRANTED = "yes"
        try {
            const seen = await inAgent(
                `outcome = process.env.AXON_PROD_GRANTED === "yes" ? "granted" : "missing"`,
                { env: { allow: ["AXON_PROD_GRANTED"] } },
            )
            expect(seen).toContain("probe:granted")
        } finally {
            delete process.env.AXON_PROD_GRANTED
        }
    }, 60_000)

    it("hides a path the fs policy did not grant", async () => {
        const dir = tempDir("axon-prod-secret-")
        const secret = join(dir, "secret.txt")
        writeFileSync(secret, "must-not-be-read")

        const seen = await inAgent(
            `await Bun.file(${JSON.stringify(secret)}).text(); outcome = "READ"`,
            // A grant naming somewhere else entirely: the secret's directory is
            // never mounted, so the path does not exist inside the box.
            { fs: { read: [tempDir("axon-prod-granted-")] } },
        )
        expect(seen).not.toContain("probe:READ")
    }, 60_000)

    /**
     * The case the slirp bug would have failed outright. With the wrong pid the
     * agent never boots at all, so this is both a network test and a
     * regression guard on the attach.
     */
    it("boots WITH a net policy — the attach targets the right namespace", async () => {
        if (!status.network) return
        const seen = await inAgent(`outcome = "alive"`, {
            net: { allow: ["20.26.156.210:443"], dns: "off" },
        })
        expect(seen).toContain("probe:alive")
    }, 90_000)

    it("blocks a host the net policy did not name", async () => {
        if (!status.network) return
        const seen = await inAgent(
            `const r = await fetch("https://1.1.1.1", { signal: AbortSignal.timeout(5000) }); outcome = "REACHED"`,
            { net: { allow: ["20.26.156.210:443"], dns: "off" } },
        )
        expect(seen).toContain("probe:blocked")
        expect(seen).not.toContain("probe:REACHED")
    }, 90_000)

    it("refuses to boot when a net policy cannot be enforced", async () => {
        // The fail-loud contract: no silent downgrade to unfiltered egress. An
        // unresolvable grant is a permission the user believes they made.
        const dir = tempDir("axon-prod-fail-")
        const root = join(dir, "agent")
        mkdirSync(root, { recursive: true })
        writeFileSync(join(root, "package.json"), JSON.stringify({ name: "p", type: "module" }))
        const entry = join(root, "main.ts")
        writeFileSync(entry, agentSource(`outcome = "alive"`))

        const boot = spawnConfined({
            sessionId: `prod-fail-${Date.now()}`,
            blueprint: { paths: { root }, tools: [], env: {} } as unknown as AxonBlueprint,
            policy: { isolation: "auto", net: { allow: ["does-not-exist.invalid:443"] } } as CapsulePolicy,
            services: { async *infer() {}, commit: () => {} } as never,
            entrypoint: entry,
            onError: () => {},
        })
        await expect(boot).rejects.toThrow(/resolve|unresolved/i)
    }, 60_000)
})
