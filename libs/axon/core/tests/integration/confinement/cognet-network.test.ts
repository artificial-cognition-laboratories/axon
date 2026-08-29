import { Axon as AxonRuntime } from "@arcforge/core"
import { KERNEL_ABI_VERSION } from "@arcforge/types"
import { defineCognet } from "@arcforge/cognet"
import { probe } from "../../../../packages/capsule/platform/confine/probe"
import { writeFileSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * The hole this reshuffle existed to close — kept as the record of what it was.
 *
 * These boot an UNCONFINED `Axon()`: no box, no supervisor, the cognet loaded
 * into the host's own heap. In that configuration the user's policy genuinely
 * does not bind cognet-authored code, and these two `.failing` assertions are
 * the measurement that proved it — with `network: {}` and `fs: { read: [...] }`
 * declared, the cognet returned REACHED on both.
 *
 * They stay `.failing` because that path is still honest about itself: a
 * runtime booted with no `remote` and no confinement has no OS wall, and
 * pretending otherwise would be the silent-degradation failure the whole
 * design refuses.
 *
 * THE CLOSURE IS PROVEN ELSEWHERE, in a real box:
 *   platform/tests/integration/confined/cognet-boxed.test.ts
 *
 * That suite runs the same probes inside bwrap and asserts both directions —
 * denied network blocks, granted network reaches; denied path is absent,
 * granted path reads. A wall that blocks everything is not a policy, so the
 * grants are asserted alongside the denials.
 */
const boxed = probe().auto ? it : it.skip

/**
 * A readable file OUTSIDE any declared fs policy. Written to the OS temp dir
 * rather than the repo so no `fs: { read: ["./"] }` grant can cover it, and
 * verified readable before each run — the assertion below is only meaningful
 * if the unconfined answer would have been "REACHED".
 */
const secret = join(tmpdir(), "axon-confinement-probe.txt")

/** Boot a runtime whose cognet runs `attempt` in its own heap at load(). */
function AxonWithProbingCognet(policy: Record<string, unknown>, attempt: () => Promise<string>) {
    let outcome: string | null = null

    return {
        get outcome() { return outcome },
        boot: () => AxonRuntime({
            blueprint: {
                config: { policy },
                cognet: {
                    name: "probe",
                    version: "1.0.0",
                    abi: KERNEL_ABI_VERSION,
                    definition: defineCognet({
                        name: "probe",
                        version: "1.0.0",
                        abi: KERNEL_ABI_VERSION,
                        mode: { kind: "invocation" },
                        async load() { outcome = await attempt() },
                        async wake() {},
                    }),
                },
                // No engine role declared, so nothing to resolve — these tests
                // never reach inference.
                profileProviders: [],
            },
        }),
    }
}

describe("confinement — the cognet is bound by the user's policy", () => {
    beforeAll(() => {
        writeFileSync(secret, "the-agent-must-not-read-this")
        // Guard the guard: if this throws, the fs test below would "pass"
        // for the wrong reason and quietly stop testing confinement.
        expect(readFileSync(secret, "utf-8")).toBe("the-agent-must-not-read-this")
    })
    afterAll(() => rmSync(secret, { force: true }))

    it.failing("a cognet cannot fetch when the user denied network", async () => {
        const probing = AxonWithProbingCognet(
            { isolation: "auto", network: {} },
            async () => {
                try {
                    await fetch("https://example.com", { signal: AbortSignal.timeout(4000) })
                    return "REACHED"
                } catch { return "blocked" }
            },
        )

        const runtime = await probing.boot()
        expect(probing.outcome).toBe("blocked")
        await runtime.shutdown()
    }, 20_000)

    it.failing("a cognet cannot read outside the declared fs policy", async () => {
        const probing = AxonWithProbingCognet(
            { isolation: "auto", fs: { read: ["./"] } },
            async () => {
                // The probe target is written by the TEST, owned by this user,
                // and plainly readable — so a "blocked" result can only mean
                // the mount namespace removed it. Probing something like
                // /etc/shadow would pass on file permissions alone and prove
                // nothing about confinement.
                try {
                    await Bun.file(secret).text()
                    return "REACHED"
                } catch { return "blocked" }
            },
        )

        const runtime = await probing.boot()
        expect(probing.outcome).toBe("blocked")
        await runtime.shutdown()
    }, 20_000)
})
