import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Bwrap } from "../../../src/confine/bwrap"
import { Cgroup } from "../../../src/confine/cgroup"
import { fromPolicy } from "../../../src/confine/spec"
import { probe } from "../../../src/confine/probe"
import { spawnConfined } from "../../../src/confined"
import type { AxonBlueprint, CapsulePolicy } from "@arcforge/types"

/**
 * ONE way to build a box in tests.
 *
 * Three harnesses used to exist — argv from `Bwrap()`/`Cgroup()`, a hand-rolled
 * `Confinement()` spawn, and production's `spawnConfined()` — and they
 * disagreed. The tests carried the correct slirp attach while production
 * carried a broken one, so the suite was green and every agent with a `net`
 * policy would have failed to boot. That is not a testing gap, it is a
 * DUPLICATION bug: coverage tracked the test's code rather than the shipped
 * code.
 *
 * So there are two entry points here and no others:
 *
 *   `inBox`   — a shell probe in a box built from the same builders production
 *               composes. Fast, for asserting one kernel behaviour at a time.
 *   `inAgent` — a real agent through `spawnConfined()`, the function the
 *               platform and the daemon call. Slower, and the only thing that
 *               can catch a bug in the spawn path itself.
 *
 * A new wall test uses one of these. If neither fits, the fix is to extend one
 * — not to write a third.
 */

export const status = probe()

/**
 * SAY SO when the wall suite is not running.
 *
 * Every boxed test is `describe.skip` off Linux, which means a macOS or
 * container CI run reports GREEN while asserting nothing about the wall — the
 * suite looks like coverage and is decorative. A skipped security test that
 * announces itself is a prompt to fix the runner; a silent one is a false sense
 * of safety, and the whole point of this layer is not to have one of those.
 *
 * Printed once per process, at import, so it lands in CI output above whatever
 * the reporter prints.
 */
if (!status.auto) {
    console.warn(
        [
            "",
            "  ⚠ OS WALL TESTS SKIPPED — no confinement available on this host.",
            `    linux=${status.isLinux} bwrap=${status.bwrap} systemd=${status.systemd}`,
            "    Nothing below asserts that fs/net/env/limits are enforced.",
            "    Run these on Linux with bubblewrap + systemd for real coverage.",
            "",
        ].join("\n"),
    )
} else if (!status.network) {
    console.warn(
        [
            "",
            "  ⚠ NETWORK WALL TESTS SKIPPED — egress filtering unavailable.",
            `    nft=${status.nft} slirp4netns=${status.slirp} capsh=${status.capsh}`,
            "    fs/env/limits still assert; per-host network enforcement does not.",
            "",
        ].join("\n"),
    )
}

const created: string[] = []

/** Remove every temp directory these helpers made. Call from `afterAll`. */
export function cleanup(): void {
    for (const dir of created) rmSync(dir, { recursive: true, force: true })
    created.length = 0
}

function scratch(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    created.push(dir)
    return dir
}

export type BoxResult = { code: number; out: string }

/**
 * Run one shell probe inside a box.
 *
 * Composed exactly as `Confinement.build()` composes it —
 * `systemd-run --scope … bwrap … -- probe` — so a change to either builder is
 * felt here. It does NOT run the launcher or attach a network stack: use
 * `inAgent` for anything involving `net`.
 */
export async function inBox(
    policy: Partial<CapsulePolicy>,
    script: string,
    env: Record<string, string> = {},
): Promise<BoxResult> {
    const spec = fromPolicy({
        policy: policy as CapsulePolicy,
        tier: "auto",
        cwd: process.cwd(),
        entrypoint: "/bin/sh",
        runtime: ["/bin/sh"],
        env,
    })
    const full = Cgroup(spec).wrap(Bwrap(spec).wrap(["/bin/sh", "-c", script]))
    const child = Bun.spawn(full, {
        // The wrapper chain runs on the HOST and systemd-run needs the session
        // bus — the same reason confined.ts passes it. Stripping it here would
        // make every boxed test fail with a dbus error rather than a verdict.
        env: process.env as Record<string, string>,
        stdout: "pipe",
        stderr: "ignore",
    })
    const out = await new Response(child.stdout).text()
    return { code: await child.exited, out: out.trim() }
}

/**
 * A self-contained probe agent.
 *
 * Imports nothing outside its own root — those files are outside the box, which
 * is the confinement working as designed — and frames its own wire messages.
 * The protocol is pinned by tests/unit/frame.test.ts.
 */
export function agentSource(body: string): string {
    return `
const paths = JSON.parse(process.env.AXON_AGENT_LINK)

function frame(message) {
    const payload = new TextEncoder().encode(JSON.stringify(message))
    const out = new Uint8Array(4 + payload.byteLength)
    new DataView(out.buffer).setUint32(0, payload.byteLength, false)
    out.set(payload, 4)
    return out
}

let outcome = "blocked"
try { ${body} } catch (error) { outcome = "blocked" }

const control = await Bun.connect({ unix: paths.control, socket: { data() {} } })
control.write(frame({ k: "send", verb: "ready", arg: {} }))

const data = await Bun.connect({ unix: paths.data, socket: { data() {} } })
data.write(frame({
    k: "send",
    verb: "commit",
    arg: { type: "axon:log:info", data: { message: "probe:" + outcome } },
}))
await new Promise(resolve => setTimeout(resolve, 300))
process.exit(0)
`
}

/**
 * Boot a real agent through `spawnConfined` and return the lines it reported.
 *
 * The agent sets `outcome` and this returns `["probe:<outcome>"]`. An empty
 * array means the agent never reported — usually a boot failure, which is a
 * legitimate outcome for a fail-loud test and a bug for anything else, so
 * assert the baseline before asserting a denial.
 */
export async function inAgent(
    body: string,
    policy: Partial<CapsulePolicy>,
    opts: { timeoutMs?: number } = {},
): Promise<string[]> {
    const dir = scratch("axon-agent-")
    const root = join(dir, "agent")
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "probe", type: "module" }))
    const entry = join(root, "main.ts")
    writeFileSync(entry, agentSource(body))

    const seen: string[] = []

    /**
     * Wait for the agent's REPORT, not for a fixed duration.
     *
     * A `setTimeout` long enough for a slow box is dead time on every run and
     * still too short on a loaded one — which is exactly how a security test
     * becomes flaky, and a flaky security test is one people learn to re-run
     * rather than read. The probe sends exactly one line, so the arrival of
     * that line is the signal; the timeout is only a backstop for an agent that
     * never boots.
     */
    let reported!: () => void
    const arrival = new Promise<void>(resolve => { reported = resolve })

    try {
        const agent = await spawnConfined({
            sessionId: `wall-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            blueprint: { paths: { root }, tools: [], env: {} } as unknown as AxonBlueprint,
            policy: { isolation: "auto", shell: { allow: ["*"] }, ...policy } as CapsulePolicy,
            services: {
                async *infer() {},
                commit: (_type: string, data: unknown) => {
                    const message = (data as { message?: string })?.message
                    if (typeof message !== "string") return
                    seen.push(message)
                    if (message.startsWith("probe:")) reported()
                },
            } as never,
            entrypoint: entry,
            onError: () => {},
        })
        await Promise.race([
            arrival,
            new Promise(resolve => setTimeout(resolve, opts.timeoutMs ?? 15_000)),
        ])
        agent.dispose()
    } catch (error) {
        if (process.env.AXON_WALL_DEBUG) console.error("spawnConfined threw:", error)
    }
    return seen
}

/** A scratch directory that is cleaned up with the rest. */
export function tempDir(prefix = "axon-wall-"): string {
    return scratch(prefix)
}
